// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import React, { useEffect, useRef } from "react";

interface Particle {
    x: number;
    y: number;
    vx: number;
    vy: number;
    size: number;
    alpha: number;
    isBit: boolean;
    bitChar: string;
}

export const CyborgDuckLoader: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
    const stageRef = useRef<HTMLDivElement | null>(null);
    const svgRef = useRef<SVGSVGElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);

    useEffect(() => {
        const stageContainer = stageRef.current;
        const duckSvg = svgRef.current;
        const canvas = canvasRef.current;
        if (!stageContainer || !duckSvg || !canvas) { return; }

        const ctx = canvas.getContext("2d");
        if (!ctx) { return; }

        const particles: Particle[] = [];
        let gridOffset = 0;
        let rafId = 0;

        const resizeCanvas = () => {
            const rect = stageContainer.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            canvas.width = rect.width * dpr;
            canvas.height = rect.height * dpr;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        };

        resizeCanvas();
        window.addEventListener("resize", resizeCanvas);

        const spawnFootstepSpark = (x: number, y: number) => {
            for (let i = 0; i < 2; i++) {
                particles.push({
                    x: x + (Math.random() * 14 - 7),
                    y: y + (Math.random() * 4 - 2),
                    vx: -(1.8 + Math.random() * 2.2),
                    vy: -(0.5 + Math.random() * 1.8),
                    size: 1.5 + Math.random() * 2,
                    alpha: 0.9,
                    isBit: Math.random() > 0.65,
                    bitChar: Math.random() > 0.5 ? "1" : "0",
                });
            }
        };

        let lastTime = performance.now();

        const animateCanvas = (now: number) => {
            const dt = (now - lastTime) / 16.67;
            lastTime = now;

            const stageRect = stageContainer.getBoundingClientRect();
            const svgRect = duckSvg.getBoundingClientRect();
            ctx.clearRect(0, 0, stageRect.width, stageRect.height);

            // Lock ground coordinates directly to the duck's shadow center (98, 228 in 220x245 viewBox)
            const centerX = svgRect.left - stageRect.left + svgRect.width * (98 / 220);
            const groundY = svgRect.top - stageRect.top + svgRect.height * (228 / 245);

            // 1. Moving treadmill ground track
            gridOffset = (gridOffset + 2.4 * dt) % 32;
            ctx.save();
            ctx.strokeStyle = "rgba(148, 163, 184, 0.25)";
            ctx.lineWidth = 2;

            ctx.beginPath();
            ctx.moveTo(centerX - 130, groundY);
            ctx.lineTo(centerX + 130, groundY);
            ctx.stroke();

            for (let x = -128; x <= 128; x += 32) {
                const tickX = centerX + x - gridOffset;
                if (tickX > centerX - 125 && tickX < centerX + 125) {
                    ctx.beginPath();
                    ctx.moveTo(tickX, groundY + 4);
                    ctx.lineTo(tickX - 8, groundY + 12);
                    ctx.stroke();
                }
            }
            ctx.restore();

            // 2. Spawn footstep sparks & binary bits
            if (Math.random() < 0.35) {
                spawnFootstepSpark(centerX - 10, groundY - 2);
            }

            // 3. Update & render particles
            for (let i = particles.length - 1; i >= 0; i--) {
                const p = particles[i];
                p.x += p.vx * dt;
                p.y += p.vy * dt;
                p.alpha -= 0.024 * dt;

                if (p.alpha <= 0) {
                    particles.splice(i, 1);
                    continue;
                }

                ctx.save();
                ctx.globalAlpha = Math.max(0, p.alpha);
                ctx.fillStyle = "#00F5FF";
                if (p.isBit) {
                    ctx.font = "10px monospace";
                    ctx.fillText(p.bitChar, p.x, p.y);
                } else {
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.restore();
            }

            rafId = requestAnimationFrame(animateCanvas);
        };

        rafId = requestAnimationFrame(animateCanvas);

        return () => {
            cancelAnimationFrame(rafId);
            window.removeEventListener("resize", resizeCanvas);
        };
    }, []);

    return (
        <div ref={stageRef} className="cyborg-duck-stage">
            <canvas ref={canvasRef} className="cyborg-duck-canvas" />

            <svg
                ref={svgRef}
                className="cyborg-duck-svg"
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 220 245"
            >
                <defs>
                    <linearGradient id="metal-outer" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" stopColor="#BCC6CF" />
                        <stop offset="50%" stopColor="#8B97A3" />
                        <stop offset="100%" stopColor="#5D6975" />
                    </linearGradient>
                    <linearGradient id="metal-inner" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" stopColor="#5A6672" />
                        <stop offset="100%" stopColor="#9BA7B3" />
                    </linearGradient>
                    <radialGradient id="core-grad" cx="42%" cy="42%" r="58%">
                        <stop offset="0%" stopColor="#FFFFFF" />
                        <stop offset="35%" stopColor="var(--cyber-glow)" />
                        <stop offset="100%" stopColor="#0095B6" />
                    </radialGradient>
                </defs>

                <g id="duck">
                    <ellipse id="shadow" cx="98" cy="228" rx="52" ry="8" fill="#000000" opacity="0.24" />

                    <g id="leg-back">
                        <path
                            d="M 108 172 L 126 172 L 126 208 L 108 208 Z"
                            fill="url(#metal-outer)"
                            stroke="#18242E"
                            strokeWidth="5"
                            strokeLinejoin="round"
                        />
                        <path d="M 109 196 Q 117 199 125 196" stroke="#47535E" strokeWidth="2.5" fill="none" />
                        <path
                            d="M 104 204 C 98 208, 99 218, 108 221 C 118 225, 136 226, 145 222 C 151 219, 150 214, 146 213 C 153 212, 155 206, 146 203 C 138 200, 129 201, 128 204 Z"
                            fill="#F99B22"
                            stroke="#18242E"
                            strokeWidth="5"
                            strokeLinejoin="round"
                        />
                        <path d="M 132 213 L 145 213" stroke="#C86D0B" strokeWidth="2.2" strokeLinecap="round" />
                    </g>

                    <g id="leg-front">
                        <path
                            d="M 62 176 L 80 176 L 78 218 L 60 216 Z"
                            fill="url(#metal-outer)"
                            stroke="#18242E"
                            strokeWidth="5"
                            strokeLinejoin="round"
                        />
                        <path d="M 62 207 Q 70 210 78 208" stroke="#47535E" strokeWidth="2.5" fill="none" />
                        <path
                            d="M 57 214 C 49 218, 46 229, 53 233 C 62 238, 75 241, 83 238 C 87 236, 87 231, 90 231 C 99 231, 104 227, 98 221 C 92 216, 84 214, 80 215 Z"
                            fill="#FFA724"
                            stroke="#18242E"
                            strokeWidth="5"
                            strokeLinejoin="round"
                        />
                        <path d="M 67 229 L 71 232" stroke="#7A4306" strokeWidth="2.5" strokeLinecap="round" />
                        <path d="M 78 223 L 94 227" stroke="#C86D0B" strokeWidth="2" strokeLinecap="round" />
                    </g>

                    <g id="torso">
                        <g id="tail">
                            <path
                                d="M 38 152 C 22 132, 14 116, 11 124 C 8 132, 14 146, 21 154 C 11 146, 9 154, 14 167 C 18 176, 27 180, 36 181 Z"
                                fill="var(--duck-body)"
                                stroke="#18242E"
                                strokeWidth="5"
                                strokeLinejoin="round"
                            />
                            <path
                                d="M 14 152 C 16 164, 23 173, 33 176"
                                stroke="var(--duck-shade)"
                                strokeWidth="4"
                                strokeLinecap="round"
                                fill="none"
                                opacity="0.7"
                            />
                        </g>

                        <g id="neck">
                            <path
                                d="M 86 122 L 143 118 L 151 138 C 128 145, 102 142, 85 132 Z"
                                fill="url(#metal-outer)"
                                stroke="#18242E"
                                strokeWidth="5"
                                strokeLinejoin="round"
                            />
                            <line x1="129" y1="120" x2="134" y2="140" stroke="#47535E" strokeWidth="3" />
                            <path
                                d="M 88 128 C 106 136, 128 137, 146 131"
                                stroke="#53606C"
                                strokeWidth="2.5"
                                fill="none"
                            />
                        </g>

                        <g id="body-main">
                            <path
                                d="M 85 130 C 56 128, 30 144, 28 168 C 26 194, 54 209, 98 209 C 142 209, 168 190, 168 162 C 168 146, 159 136, 148 131 C 128 141, 104 139, 85 130 Z"
                                fill="var(--duck-body)"
                                stroke="#18242E"
                                strokeWidth="5"
                                strokeLinejoin="round"
                            />
                            <path
                                d="M 34 174 C 44 198, 76 205, 114 204 C 142 203, 160 190, 164 170 C 154 190, 126 198, 94 197 C 62 196, 42 186, 34 174 Z"
                                fill="var(--duck-shade)"
                                opacity="0.65"
                            />
                            <path
                                d="M 140 137 C 150 158, 149 186, 126 205"
                                stroke="#4E6A7D"
                                strokeWidth="3"
                                strokeLinecap="round"
                                fill="none"
                            />
                            <circle cx="129" cy="148" r="3.2" fill="#253642" />
                            <circle cx="126" cy="179" r="3.2" fill="#253642" />

                            <g id="chest-unit">
                                <rect
                                    x="146"
                                    y="150"
                                    width="21"
                                    height="17"
                                    rx="4.5"
                                    transform="rotate(-8 156 158)"
                                    fill="#253642"
                                    stroke="#18242E"
                                    strokeWidth="3"
                                />
                                <rect
                                    id="chest-core"
                                    x="149"
                                    y="153"
                                    width="15"
                                    height="11"
                                    rx="2.5"
                                    transform="rotate(-8 156 158)"
                                    fill="var(--cyber-glow)"
                                />
                                <line
                                    x1="151"
                                    y1="156"
                                    x2="161"
                                    y2="155"
                                    stroke="#FFFFFF"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    opacity="0.85"
                                />
                            </g>
                        </g>

                        <g id="head">
                            <path
                                d="M 118 26 C 113 13, 94 6, 82 10 C 74 13, 79 25, 86 32 C 74 29, 63 32, 63 40 C 63 45, 69 47, 74 47 C 56 60, 49 82, 56 102 C 63 121, 86 131, 114 131 C 147 131, 178 118, 184 94 C 190 66, 174 36, 144 27 C 134 24, 125 24, 118 26 Z"
                                fill="var(--duck-body)"
                                stroke="#18242E"
                                strokeWidth="5"
                                strokeLinejoin="round"
                            />
                            <path
                                d="M 72 52 C 58 66, 54 86, 62 104 C 69 118, 86 126, 108 128 C 84 123, 67 111, 63 94 C 59 77, 64 62, 72 52 Z"
                                fill="var(--duck-shade)"
                                opacity="0.6"
                            />
                            <ellipse
                                cx="137"
                                cy="34"
                                rx="7"
                                ry="4"
                                transform="rotate(18 137 34)"
                                fill="#EBF8FF"
                                opacity="0.85"
                            />
                            <ellipse
                                cx="150"
                                cy="40"
                                rx="8.5"
                                ry="4.8"
                                transform="rotate(28 150 40)"
                                fill="#EBF8FF"
                                opacity="0.85"
                            />

                            <path
                                d="M 70 43 C 78 49, 91 53, 91 63 L 90 73"
                                stroke="#4E6A7D"
                                strokeWidth="3"
                                strokeLinecap="round"
                                fill="none"
                            />
                            <path
                                d="M 54 92 L 66 92"
                                stroke="#4E6A7D"
                                strokeWidth="3"
                                strokeLinecap="round"
                                fill="none"
                            />
                            <path
                                d="M 91 109 C 93 118, 98 125, 103 130"
                                stroke="#4E6A7D"
                                strokeWidth="3"
                                strokeLinecap="round"
                                fill="none"
                            />

                            <circle cx="85" cy="64" r="3" fill="#253642" />
                            <circle cx="61" cy="98" r="3" fill="#253642" />

                            <g id="cyber-ear">
                                <circle
                                    cx="86"
                                    cy="90"
                                    r="21"
                                    fill="url(#metal-outer)"
                                    stroke="#253642"
                                    strokeWidth="4"
                                />
                                <circle
                                    cx="86"
                                    cy="90"
                                    r="14"
                                    fill="url(#metal-inner)"
                                    stroke="#253642"
                                    strokeWidth="3"
                                />
                                <circle id="cyber-core" cx="86" cy="90" r="10.5" fill="url(#core-grad)" />
                                <circle cx="82" cy="86" r="3" fill="#FFFFFF" opacity="0.8" />
                            </g>

                            <g id="eye-lid">
                                <ellipse cx="140" cy="85" rx="8.5" ry="12.5" fill="#18242E" />
                                <ellipse cx="142.5" cy="80" rx="3.2" ry="4.5" fill="#FFFFFF" />
                            </g>

                            <g id="beak">
                                <path
                                    id="beak-bottom"
                                    d="M 156 102 C 156 114, 178 122, 196 115 C 206 111, 212 103, 212 97 C 196 105, 174 106, 156 102 Z"
                                    fill="#F08716"
                                    stroke="#18242E"
                                    strokeWidth="5"
                                    strokeLinejoin="round"
                                />
                                <path
                                    id="beak-top"
                                    d="M 176 80 C 181 79, 189 87, 200 90 C 210 92, 214 94, 213 99 C 210 108, 193 116, 173 113 C 158 111, 151 105, 154 98 C 157 91, 169 81, 176 80 Z"
                                    fill="#FFA724"
                                    stroke="#18242E"
                                    strokeWidth="5"
                                    strokeLinejoin="round"
                                />
                                <circle cx="177" cy="91" r="2.8" fill="#253642" />
                                <ellipse
                                    cx="204"
                                    cy="94.5"
                                    rx="4.8"
                                    ry="2.2"
                                    transform="rotate(-10 204 94.5)"
                                    fill="#FFC86B"
                                    stroke="#C86D0B"
                                    strokeWidth="1"
                                />
                            </g>
                        </g>

                        <g id="wing">
                            <path
                                d="M 82 138 C 58 138, 30 148, 26 164 C 23 176, 34 182, 45 178 C 43 188, 54 196, 68 193 C 88 189, 106 175, 106 157 C 106 144, 96 138, 82 138 Z"
                                fill="var(--duck-body)"
                                stroke="#18242E"
                                strokeWidth="5"
                                strokeLinejoin="round"
                            />
                            <path
                                d="M 30 168 C 33 176, 40 177, 46 174 C 46 184, 56 191, 69 188 C 85 185, 99 173, 102 159 C 96 174, 82 183, 66 185 C 55 186, 48 180, 48 171 C 39 175, 32 173, 30 168 Z"
                                fill="var(--duck-shade)"
                                opacity="0.65"
                            />
                            <path
                                d="M 46 149 C 62 141, 82 140, 94 146"
                                stroke="#EBF8FF"
                                strokeWidth="4"
                                strokeLinecap="round"
                                fill="none"
                                opacity="0.85"
                            />
                            <circle cx="95" cy="156" r="4" fill="#253642" />
                        </g>
                    </g>
                </g>
            </svg>

            {children}
        </div>
    );
};
