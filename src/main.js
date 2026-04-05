import { createApp } from 'vue';
import App from './App.vue';
import './style.css';

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  // Use BASE_URL so this works when deployed under a sub-path.
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}

createApp(App).mount('#app');
