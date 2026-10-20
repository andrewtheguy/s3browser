//! A streaming ZIP64 writer: entries are deflated as their data arrives and
//! nothing is buffered beyond the compressor's window, so an archive of any
//! size goes out in one pass. Sizes and CRCs follow each entry's data in a
//! data descriptor, and every size and offset is a 64-bit ZIP64 field.

use flate2::{Compress, Compression, FlushCompress, Status};

const LOCAL_HEADER_SIGNATURE: u32 = 0x0403_4b50;
const DATA_DESCRIPTOR_SIGNATURE: u32 = 0x0807_4b50;
const CENTRAL_HEADER_SIGNATURE: u32 = 0x0201_4b50;
const ZIP64_END_SIGNATURE: u32 = 0x0606_4b50;
const ZIP64_LOCATOR_SIGNATURE: u32 = 0x0706_4b50;
const END_SIGNATURE: u32 = 0x0605_4b50;
/// ZIP64 needs 4.5.
const VERSION_NEEDED: u16 = 45;
/// Unix host (3), spec 4.5: lets readers apply the external attributes.
const VERSION_MADE_BY: u16 = (3 << 8) | 45;
/// Bit 3: sizes in a trailing data descriptor; bit 11: UTF-8 names.
const FLAGS: u16 = (1 << 3) | (1 << 11);
const METHOD_DEFLATE: u16 = 8;
const ZIP64_EXTRA_ID: u16 = 0x0001;
/// Regular file, mode 0600.
const FILE_MODE: u32 = 0o100_600;

struct Entry {
    name: Vec<u8>,
    dos_time: u16,
    dos_date: u16,
    offset: u64,
    compress: Compress,
    crc: crc32fast::Hasher,
    uncompressed: u64,
    compressed: u64,
}

struct Finished {
    name: Vec<u8>,
    dos_time: u16,
    dos_date: u16,
    offset: u64,
    crc: u32,
    uncompressed: u64,
    compressed: u64,
}

#[derive(Default)]
pub struct ZipWriter {
    offset: u64,
    current: Option<Entry>,
    finished: Vec<Finished>,
}

impl ZipWriter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Every byte returned to the caller passes through here, so `offset`
    /// stays the archive position for the central directory.
    fn emit(&mut self, bytes: Vec<u8>) -> Vec<u8> {
        self.offset += bytes.len() as u64;
        bytes
    }

    /// Start an entry (ending none: call [`end_entry`](Self::end_entry) first)
    /// and return its local header.
    pub fn begin_entry(&mut self, name: &str, modified_unix_secs: i64) -> Vec<u8> {
        assert!(self.current.is_none(), "begin_entry while an entry is open");
        let (dos_time, dos_date) = dos_date_time(modified_unix_secs);
        let name = name.as_bytes().to_vec();
        let mut header = Vec::with_capacity(30 + name.len() + 20);
        put_u32(&mut header, LOCAL_HEADER_SIGNATURE);
        put_u16(&mut header, VERSION_NEEDED);
        put_u16(&mut header, FLAGS);
        put_u16(&mut header, METHOD_DEFLATE);
        put_u16(&mut header, dos_time);
        put_u16(&mut header, dos_date);
        put_u32(&mut header, 0); // CRC, in the data descriptor
        put_u32(&mut header, u32::MAX); // sizes, in the ZIP64 extra field
        put_u32(&mut header, u32::MAX);
        put_u16(&mut header, name.len() as u16);
        put_u16(&mut header, 20);
        header.extend_from_slice(&name);
        put_u16(&mut header, ZIP64_EXTRA_ID);
        put_u16(&mut header, 16);
        put_u64(&mut header, 0); // unknown until the data descriptor
        put_u64(&mut header, 0);
        let offset = self.offset;
        self.current = Some(Entry {
            name,
            dos_time,
            dos_date,
            offset,
            compress: Compress::new(Compression::default(), false),
            crc: crc32fast::Hasher::new(),
            uncompressed: 0,
            compressed: 0,
        });
        self.emit(header)
    }

    /// Feed data to the open entry; returns compressed bytes ready to send
    /// (often empty while the compressor fills its window).
    pub fn write(&mut self, data: &[u8]) -> Vec<u8> {
        let entry = self.current.as_mut().expect("write without an open entry");
        entry.crc.update(data);
        entry.uncompressed += data.len() as u64;
        let out = deflate(&mut entry.compress, data, FlushCompress::None);
        entry.compressed += out.len() as u64;
        self.emit(out)
    }

    /// Finish the open entry: the compressor's tail plus the data descriptor.
    pub fn end_entry(&mut self) -> Vec<u8> {
        let mut entry = self.current.take().expect("end_entry without an open entry");
        let mut out = deflate(&mut entry.compress, &[], FlushCompress::Finish);
        entry.compressed += out.len() as u64;
        let crc = entry.crc.finalize();
        put_u32(&mut out, DATA_DESCRIPTOR_SIGNATURE);
        put_u32(&mut out, crc);
        put_u64(&mut out, entry.compressed);
        put_u64(&mut out, entry.uncompressed);
        self.finished.push(Finished {
            name: entry.name,
            dos_time: entry.dos_time,
            dos_date: entry.dos_date,
            offset: entry.offset,
            crc,
            uncompressed: entry.uncompressed,
            compressed: entry.compressed,
        });
        self.emit(out)
    }

    /// The central directory and end records. Consumes the writer.
    pub fn finish(mut self) -> Vec<u8> {
        assert!(self.current.is_none(), "finish while an entry is open");
        let central_offset = self.offset;
        let mut out = Vec::new();
        for entry in &self.finished {
            put_u32(&mut out, CENTRAL_HEADER_SIGNATURE);
            put_u16(&mut out, VERSION_MADE_BY);
            put_u16(&mut out, VERSION_NEEDED);
            put_u16(&mut out, FLAGS);
            put_u16(&mut out, METHOD_DEFLATE);
            put_u16(&mut out, entry.dos_time);
            put_u16(&mut out, entry.dos_date);
            put_u32(&mut out, entry.crc);
            put_u32(&mut out, u32::MAX);
            put_u32(&mut out, u32::MAX);
            put_u16(&mut out, entry.name.len() as u16);
            put_u16(&mut out, 28); // ZIP64 extra: header + three u64
            put_u16(&mut out, 0); // comment
            put_u16(&mut out, 0); // disk number
            put_u16(&mut out, 0); // internal attributes
            put_u32(&mut out, FILE_MODE << 16);
            put_u32(&mut out, u32::MAX); // local header offset, in the extra field
            out.extend_from_slice(&entry.name);
            put_u16(&mut out, ZIP64_EXTRA_ID);
            put_u16(&mut out, 24);
            put_u64(&mut out, entry.uncompressed);
            put_u64(&mut out, entry.compressed);
            put_u64(&mut out, entry.offset);
        }
        let central_size = out.len() as u64;
        let zip64_end_offset = central_offset + central_size;
        let count = self.finished.len() as u64;

        put_u32(&mut out, ZIP64_END_SIGNATURE);
        put_u64(&mut out, 44); // size of the rest of this record
        put_u16(&mut out, VERSION_MADE_BY);
        put_u16(&mut out, VERSION_NEEDED);
        put_u32(&mut out, 0); // this disk
        put_u32(&mut out, 0); // disk with the central directory
        put_u64(&mut out, count);
        put_u64(&mut out, count);
        put_u64(&mut out, central_size);
        put_u64(&mut out, central_offset);

        put_u32(&mut out, ZIP64_LOCATOR_SIGNATURE);
        put_u32(&mut out, 0);
        put_u64(&mut out, zip64_end_offset);
        put_u32(&mut out, 1); // total disks

        put_u32(&mut out, END_SIGNATURE);
        put_u16(&mut out, 0);
        put_u16(&mut out, 0);
        put_u16(&mut out, u16::MAX);
        put_u16(&mut out, u16::MAX);
        put_u32(&mut out, u32::MAX);
        put_u32(&mut out, u32::MAX);
        put_u16(&mut out, 0); // comment
        self.emit(out)
    }
}

/// Run the compressor over all of `input`, growing the output as needed.
fn deflate(compress: &mut Compress, mut input: &[u8], flush: FlushCompress) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len() / 2 + 64);
    loop {
        if out.capacity() - out.len() < 1024 {
            out.reserve(64 * 1024);
        }
        let before = compress.total_in();
        let status = compress
            .compress_vec(input, &mut out, flush)
            .expect("deflating an in-memory buffer cannot fail");
        input = &input[(compress.total_in() - before) as usize..];
        let done = match flush {
            FlushCompress::Finish => status == Status::StreamEnd,
            _ => input.is_empty() && out.len() < out.capacity(),
        };
        if done {
            return out;
        }
    }
}

/// MS-DOS time and date fields (UTC), clamped to the format's 1980–2107 range.
fn dos_date_time(unix_secs: i64) -> (u16, u16) {
    const MIN: i64 = 315_532_800; // 1980-01-01T00:00:00Z
    const MAX: i64 = 4_354_819_198; // 2107-12-31T23:59:58Z
    let secs = unix_secs.clamp(MIN, MAX);
    let days = secs.div_euclid(86_400);
    let time_of_day = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let time = ((time_of_day / 3600) << 11) | (((time_of_day % 3600) / 60) << 5) | ((time_of_day % 60) / 2);
    let date = ((year - 1980) << 9) | (month << 5) | day;
    (time as u16, date as u16)
}

/// Gregorian (year, month, day) for days since 1970-01-01 (Howard Hinnant's
/// `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

fn put_u16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn put_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn put_u64(out: &mut Vec<u8>, value: u64) {
    out.extend_from_slice(&value.to_le_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Read};

    fn read_archive(bytes: &[u8]) -> Vec<(String, Vec<u8>, Option<u32>)> {
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        (0..archive.len())
            .map(|i| {
                let mut file = archive.by_index(i).unwrap();
                let mut data = Vec::new();
                file.read_to_end(&mut data).unwrap();
                (file.name().to_string(), data, file.unix_mode())
            })
            .collect()
    }

    #[test]
    fn writes_a_readable_archive_in_pieces() {
        let big: Vec<u8> = (0..300_000u32).flat_map(|i| (i % 251).to_le_bytes()).collect();
        let mut zip = ZipWriter::new();
        let mut out = zip.begin_entry("folder/報告.txt", 1_700_000_000);
        for chunk in big.chunks(65_536) {
            out.extend(zip.write(chunk));
        }
        out.extend(zip.end_entry());
        out.extend(zip.begin_entry("empty.txt", 0));
        out.extend(zip.end_entry());
        out.extend(zip.finish());

        let entries = read_archive(&out);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].0, "folder/報告.txt");
        assert_eq!(entries[0].1, big);
        assert_eq!(entries[0].2, Some(0o100_600));
        assert_eq!((entries[1].0.as_str(), entries[1].1.len()), ("empty.txt", 0));
    }

    #[test]
    fn empty_archive_is_valid() {
        assert!(read_archive(&ZipWriter::new().finish()).is_empty());
    }

    #[test]
    fn dos_timestamps() {
        // 2023-11-14T22:13:20Z
        let (time, date) = dos_date_time(1_700_000_000);
        assert_eq!((date >> 9, (date >> 5) & 0xF, date & 0x1F), (43, 11, 14));
        assert_eq!((time >> 11, (time >> 5) & 0x3F, (time & 0x1F) * 2), (22, 13, 20));
        assert_eq!(dos_date_time(0), (0, 1 << 5 | 1));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
    }
}
