import { Outlet } from 'react-router';
import { S3ClientProvider } from '../contexts';

export function RootLayout() {
  return (
    <S3ClientProvider>
      <Outlet />
    </S3ClientProvider>
  );
}
