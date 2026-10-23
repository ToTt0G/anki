// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import React from "react";
import { createRoot } from "react-dom/client";
import { SandboxedCardFrame } from "../../src/components/SandboxedCardFrame";

const host = document.createElement("div");
document.body.append(host);
createRoot(host).render(<SandboxedCardFrame html={String.raw`\[\color{red}{x^2 + y^2 = z^2}\]`} />);
void navigator.serviceWorker.register("/sw.js");
