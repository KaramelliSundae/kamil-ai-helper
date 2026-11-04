import { registerRootComponent } from 'expo';

// Defines the background task. It must load before the app, because Android may start it with no UI.
import './src/background';
import App from './App';

registerRootComponent(App);
