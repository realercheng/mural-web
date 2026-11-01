import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { migrateLegacyKidRecords } from './history';
import './styles.css';

// Kid conversations move from localStorage to IndexedDB before the app reads kid data. If the move
// fails, they stay in localStorage and are tried again next time.
migrateLegacyKidRecords().catch(() => {}).finally(() => {
  createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
});
