import { Route, Routes } from "react-router";

import Home from "./pages/Home";
import ProjectDetail from "./pages/project/ProjectDetail";
import Session from "./pages/session/Session";
import Sparks from "./pages/Sparks";

function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/sparks" element={<Sparks />} />
      <Route path="/session/:id" element={<Session />} />
      <Route path="/project/:id" element={<ProjectDetail />} />
    </Routes>
  );
}

export default App;
