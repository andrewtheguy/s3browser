import { useEffect } from 'react';
import { useParams } from 'react-router';
import { Card, CardContent } from '@/components/ui/card';
import { CenteredLoader } from '../components/CenteredLoader';
import { ConnectionForm } from '../components/ConnectionForm';
import { PageContainer } from '../components/PageContainer';
import { useConnectionQuery } from '../queries/connections';
import { parseConnectionId } from '../utils/urlEncoding';

/** `/connection/new` creates; `/connection/:connectionId/edit` (under ConnectionLayout) edits. */
export function ConnectionFormPage() {
  const { connectionId: raw } = useParams<{ connectionId?: string }>();
  const connectionId = parseConnectionId(raw);
  const isEdit = connectionId !== null;
  const { data: connection } = useConnectionQuery(connectionId);

  useEffect(() => {
    document.title = `${isEdit ? 'Edit connection' : 'New connection'} - s3browser`;
  }, [isEdit]);

  if (isEdit && !connection) {
    return <CenteredLoader />;
  }

  return (
    <PageContainer className="max-w-xl">
      <h1 className="mb-4 text-2xl font-semibold tracking-tight">{isEdit ? 'Edit connection' : 'New connection'}</h1>
      <Card className="border-0 shadow-none sm:border sm:shadow-sm">
        <CardContent className="p-0 sm:p-6">
          <ConnectionForm key={connection?.id ?? 'new'} connection={connection} />
        </CardContent>
      </Card>
    </PageContainer>
  );
}
