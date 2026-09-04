import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

function App() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <h1>⚡ Live from WebContainer</h1>
      <p>This React app was mounted from a host workspace through the selected WebContainer API source: File Tree or native Snapshot.</p>
      <button onClick={() => setCount((c) => c + 1)}>Clicked {count} times</button>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
