import { cn } from "@/lib/utils";

interface BucketIconProps {
  className?: string;
}

export function BucketIcon({ className }: BucketIconProps) {
  return (
    <svg
      viewBox="21 20 58 58"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("h-6 w-6", className)}
      fill="currentColor"
    >
      <path
        d="M49.995,21.806c15.113,0,27.363,2.877,27.363,6.424c0,3.562-12.25,6.431-27.363,6.431c-15.105,0-27.354-2.868-27.354-6.431C22.642,24.683,34.89,21.806,49.995,21.806z"
        opacity="0.9"
      />
      <path
        d="M49.995,39.095c14.088,0,25.684-2.49,27.193-5.707l-8.947,38.199c0,2.372-8.166,4.28-18.246,4.28c-10.07,0-18.234-1.908-18.234-4.28l-8.949-38.199C24.323,36.604,35.917,39.095,49.995,39.095z"
      />
      <polygon
        points="77.188,33.388 77.188,35.714 68.241,73.909 68.241,71.587"
        opacity="0.7"
      />
      <polygon
        points="31.761,71.587 31.761,73.909 22.812,35.714 22.812,33.388"
        opacity="0.7"
      />
    </svg>
  );
}
