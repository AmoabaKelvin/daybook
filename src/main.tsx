import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { QuickCapture } from './components/QuickCapture'
import { isNative, isQuickPanel } from './lib/native'

if (isNative) document.documentElement.classList.add(isQuickPanel ? 'quick' : 'native')

createRoot(document.getElementById('root')!).render(<StrictMode>{isQuickPanel ? <QuickCapture /> : <App />}</StrictMode>)
