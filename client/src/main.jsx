import React from 'react';
import ReactDOM from 'react-dom/client';
import { LazyMotion, domAnimation } from 'framer-motion';
import App from './App.jsx';
import { AuthProvider } from './context/AuthContext.jsx';
import { ToastProvider } from './components/ui/Toast.jsx';
import './index.css';

/**
 * LazyMotion loads the animation feature set on demand instead of bundling the
 * full framer-motion runtime into the initial chunk — the difference between
 * roughly 114 KB and 35 KB of JavaScript every first-time visitor downloads
 * before seeing anything. The trade is that the tree below must use the slim
 * `m` component rather than `motion`; `strict` turns any straggler into a loud
 * error in development rather than a silently heavier bundle.
 */
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <LazyMotion features={domAnimation} strict>
      <ToastProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ToastProvider>
    </LazyMotion>
  </React.StrictMode>
);