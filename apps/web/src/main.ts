import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import './styles/personal-standard.css';

createApp(App).use(createPinia()).use(router).mount('#app');

import './styles/page-headings.css';
