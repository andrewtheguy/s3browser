import { ThemeProvider, createTheme, CssBaseline } from '@mui/material';
import { S3ClientProvider, BrowserProvider, useS3ClientContext } from './contexts';
import { LoginForm } from './components/LoginForm';
import { BucketSelector } from './components/BucketSelector';
import { S3Browser } from './components/S3Browser';

const theme = createTheme({
  palette: {
    mode: 'light',
    primary: {
      main: '#1976d2',
    },
    background: {
      default: '#f5f5f5',
    },
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: 'none',
        },
      },
    },
  },
});

function AppContent() {
  const { isConnected, requiresBucketSelection } = useS3ClientContext();

  if (!isConnected) {
    return <LoginForm />;
  }

  if (requiresBucketSelection) {
    return <BucketSelector />;
  }

  return (
    <BrowserProvider>
      <S3Browser />
    </BrowserProvider>
  );
}

function App() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <S3ClientProvider>
        <AppContent />
      </S3ClientProvider>
    </ThemeProvider>
  );
}

export default App;
