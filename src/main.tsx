import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
// Configure Monaco to load from the local bundle (not the blocked CDN) before
// any editor mounts — otherwise the editor hangs on "Loading...".
import './lib/monaco-setup';
import './styles/index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
