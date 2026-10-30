import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { IS_WEB } from './platform'
import './style.css'

// The layout rules of the web version (narrow screen) all sit under `html.web`:
// on the desktop the class is not there, so none of those rules can touch it.
if (IS_WEB) document.documentElement.classList.add('web')

const app = createApp(App)
app.use(createPinia())
app.mount('#app')
