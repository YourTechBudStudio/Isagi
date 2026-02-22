import { Route, Routes } from "react-router";

import Home from "./pages/Home";
import Session from "./pages/session/Session";

function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/session/:id" element={<Session />} />
    </Routes>
  );
}

export default App;
