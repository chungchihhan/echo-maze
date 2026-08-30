"use client";

import { useEffect, useRef } from "react";
import type { Group, Texture } from "three";
import type { Maze } from "../lib/maze/types.js";

type WallSegment = { x1: number; z1: number; x2: number; z2: number };

const WALL_HEIGHT = 1.16;
const WALL_THICKNESS = 0.085;
const WALL_STEP = 0.12;
const WALL_LEVELS = 11;
const ICE = "#f0f7ff";

function getWallSegments(maze: Maze): WallSegment[] {
  const size = maze.cells.length;
  const origin = size / 2;
  const segments: WallSegment[] = [];

  for (const cell of maze.cells.flat()) {
    const x = cell.c - origin;
    const z = cell.r - origin;

    if (cell.walls.up) segments.push({ x1: x, z1: z, x2: x + 1, z2: z });
    if (cell.walls.left) segments.push({ x1: x, z1: z, x2: x, z2: z + 1 });
    if (cell.r === size - 1 && cell.walls.down) segments.push({ x1: x, z1: z + 1, x2: x + 1, z2: z + 1 });
    if (cell.c === size - 1 && cell.walls.right) segments.push({ x1: x + 1, z1: z, x2: x + 1, z2: z + 1 });
  }

  return segments;
}

function cellCenter(maze: Maze, point: { r: number; c: number }) {
  const origin = maze.cells.length / 2;
  return { x: point.c - origin + 0.5, z: point.r - origin + 0.5 };
}

function seededNoise(index: number) {
  const value = Math.sin(index * 12.9898 + 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function createFallback(maze: Maze) {
  const size = maze.cells.length;
  const origin = size / 2;

  return (
    <svg className="hero-maze-fallback" viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <rect x="0.25" y="0.25" width={size - 0.5} height={size - 0.5} fill="none" stroke="currentColor" strokeOpacity=".28" />
      {getWallSegments(maze).map((segment, index) => (
        <line
          key={`fallback-wall-${index}`}
          x1={segment.x1 + origin}
          y1={segment.z1 + origin}
          x2={segment.x2 + origin}
          y2={segment.z2 + origin}
          stroke="currentColor"
          strokeWidth=".055"
          strokeLinecap="square"
        />
      ))}
      <circle cx={maze.start.c + 0.5} cy={maze.start.r + 0.5} r=".18" fill="currentColor" />
      <circle cx={maze.exit.c + 0.5} cy={maze.exit.r + 0.5} r=".11" fill="currentColor" opacity=".56" />
    </svg>
  );
}

function makeGlyphTexture(three: typeof import("three"), value: string, size = 64): Texture {
  const surface = document.createElement("canvas");
  surface.width = size;
  surface.height = size;
  const context = surface.getContext("2d");
  if (context) {
    context.clearRect(0, 0, size, size);
    context.fillStyle = ICE;
    const fontScale = value.length > 1 ? 0.28 : 0.62;
    context.font = `400 ${Math.round(size * fontScale)}px monospace`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(value, size / 2, size / 2 + 1);
  }
  const texture = new three.CanvasTexture(surface);
  texture.colorSpace = three.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function addGlyph(
  three: typeof import("three"),
  group: Group,
  texture: Texture,
  x: number,
  y: number,
  z: number,
  scale = 0.18,
  opacity = 0.44,
) {
  const material = new three.SpriteMaterial({
    map: texture,
    color: ICE,
    transparent: true,
    opacity,
    depthWrite: false,
  });
  const sprite = new three.Sprite(material);
  sprite.position.set(x, y, z);
  sprite.scale.set(scale, scale, 1);
  group.add(sprite);
  return material;
}

function createWallMaterial(three: typeof import("three")) {
  return new three.ShaderMaterial({
    transparent: true,
    side: three.DoubleSide,
    depthWrite: false,
    uniforms: {
      baseColor: { value: new three.Color(0x527ceb) },
      highlightColor: { value: new three.Color(0xf0f7ff) },
      time: { value: 0 },
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vNormal;

      void main() {
        vUv = uv;
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 baseColor;
      uniform vec3 highlightColor;
      uniform float time;
      varying vec2 vUv;
      varying vec3 vNormal;

      void main() {
        vec2 grid = vUv * vec2(30.0, 22.0);
        vec2 cell = fract(grid) - 0.5;
        float dots = 1.0 - smoothstep(0.08, 0.22, length(cell));
        float facing = 0.5 + 0.5 * abs(vNormal.y);
        float shimmer = 0.5 + 0.5 * sin(grid.x * 0.38 + grid.y * 0.57 + time * 0.7);
        vec3 color = mix(baseColor, highlightColor, dots * 0.68 + facing * 0.13 + shimmer * 0.04);
        float alpha = 0.08 + dots * 0.46 + facing * 0.08;
        gl_FragColor = vec4(color, alpha);
      }
    `,
  });
}

export function HeroMaze({ maze }: { maze: Maze }) {
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    let disposed = false;
    let cleanup: (() => void) | null = null;

    const setup = async () => {
      const [three, controlsModule] = await Promise.all([
        import("three"),
        import("three/addons/controls/OrbitControls.js"),
      ]);
      if (disposed) return;

      const canvas = document.createElement("canvas");
      canvas.className = "hero-maze-canvas";
      canvas.setAttribute("aria-hidden", "true");
      stage.appendChild(canvas);

      let renderer: InstanceType<typeof three.WebGLRenderer>;
      try {
        renderer = new three.WebGLRenderer({
          canvas,
          alpha: true,
          antialias: true,
          powerPreference: "high-performance",
        });
      } catch {
        canvas.remove();
        return;
      }

      const { OrbitControls } = controlsModule;
      const size = maze.cells.length;
      const segments = getWallSegments(maze);
      const scene = new three.Scene();
      const camera = new three.PerspectiveCamera(42, 1, 0.1, 100);
      // Favor a closer, more immersive frame; edge cropping during auto-orbit is intentional.
      camera.position.set(0, 22, 1.65);

      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setClearColor(0x0033e5, 0);
      renderer.outputColorSpace = three.SRGBColorSpace;

      const controls = new OrbitControls(camera, canvas);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.enablePan = false;
      controls.enableZoom = false;
      controls.autoRotate = true;
      controls.autoRotateSpeed = 0.55;
      controls.rotateSpeed = 0.65;
      controls.minDistance = 17;
      controls.maxDistance = 32;
      controls.minPolarAngle = 0.01;
      controls.maxPolarAngle = 1.42;
      controls.target.set(0, 0, 0);
      controls.update();

      const mazeGroup = new three.Group();
      scene.add(mazeGroup);

      const floor = new three.Mesh(
        new three.PlaneGeometry(size + 0.3, size + 0.3),
        new three.MeshBasicMaterial({ color: 0x0033e5, transparent: true, opacity: 0.18, side: three.DoubleSide, depthWrite: false }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -0.035;
      scene.add(floor);

      const grid = new three.GridHelper(size, size, 0x527ceb, 0x527ceb);
      const gridMaterials = (Array.isArray(grid.material) ? grid.material : [grid.material]) as Array<InstanceType<typeof three.LineBasicMaterial>>;
      gridMaterials.forEach((material) => {
        material.transparent = true;
        material.opacity = 0.12;
        material.depthWrite = false;
      });
      grid.position.y = -0.02;
      scene.add(grid);

      const wallMaterial = createWallMaterial(three);
      const wallGeometries: Array<InstanceType<typeof three.BoxGeometry>> = [];
      for (const segment of segments) {
        const horizontal = Math.abs(segment.x2 - segment.x1) > Math.abs(segment.z2 - segment.z1);
        const length = horizontal ? Math.abs(segment.x2 - segment.x1) : Math.abs(segment.z2 - segment.z1);
        const geometry = horizontal
          ? new three.BoxGeometry(length, WALL_HEIGHT, WALL_THICKNESS)
          : new three.BoxGeometry(WALL_THICKNESS, WALL_HEIGHT, length);
        const wall = new three.Mesh(geometry, wallMaterial);
        wall.position.set((segment.x1 + segment.x2) / 2, WALL_HEIGHT / 2, (segment.z1 + segment.z2) / 2);
        mazeGroup.add(wall);
        wallGeometries.push(geometry);
      }

      const linePositions: number[] = [];
      const addLine = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number) => {
        linePositions.push(x1, y1, z1, x2, y2, z2);
      };
      for (const segment of segments) {
        addLine(segment.x1, 0, segment.z1, segment.x2, 0, segment.z2);
        addLine(segment.x1, WALL_HEIGHT, segment.z1, segment.x2, WALL_HEIGHT, segment.z2);
        addLine(segment.x1, 0, segment.z1, segment.x1, WALL_HEIGHT, segment.z1);
        addLine(segment.x2, 0, segment.z2, segment.x2, WALL_HEIGHT, segment.z2);
      }
      const lineGeometry = new three.BufferGeometry();
      lineGeometry.setAttribute("position", new three.Float32BufferAttribute(linePositions, 3));
      const lineMaterial = new three.LineBasicMaterial({ color: ICE, transparent: true, opacity: 0.72, depthWrite: false });
      const lines = new three.LineSegments(lineGeometry, lineMaterial);
      mazeGroup.add(lines);

      const particlePositions: number[] = [];
      let particleIndex = 0;
      for (const segment of segments) {
        const dx = segment.x2 - segment.x1;
        const dz = segment.z2 - segment.z1;
        const length = Math.hypot(dx, dz);
        const steps = Math.max(2, Math.ceil(length / WALL_STEP));
        const normalX = -dz * 0.045;
        const normalZ = dx * 0.045;
        for (let step = 0; step <= steps; step += 1) {
          const progress = step / steps;
          for (let level = 0; level <= WALL_LEVELS; level += 1) {
            const noise = seededNoise(particleIndex);
            const y = 0.04 + (level / WALL_LEVELS) * (WALL_HEIGHT - 0.08) + (noise - 0.5) * 0.035;
            for (const side of [-1, 1]) {
              const x = segment.x1 + dx * progress + normalX * side + normalX * (noise - 0.5) * 0.35;
              const z = segment.z1 + dz * progress + normalZ * side + normalZ * (noise - 0.5) * 0.35;
              particlePositions.push(x, y, z);
              particleIndex += 1;
            }
          }
        }
      }
      const particleGeometry = new three.BufferGeometry();
      particleGeometry.setAttribute("position", new three.Float32BufferAttribute(particlePositions, 3));
      const particleMaterial = new three.PointsMaterial({
        color: ICE,
        size: 0.06,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.75,
        depthWrite: false,
        blending: three.AdditiveBlending,
      });
      const particles = new three.Points(particleGeometry, particleMaterial);
      mazeGroup.add(particles);

      const glyphTextures = new Map<string, Texture>();
      const glyphMaterials: Array<InstanceType<typeof three.SpriteMaterial>> = [];
      const glyphGroup = new three.Group();
      const glyphs = ["@", "·", "+", "x", "/", "#", ":"];
      const textureFor = (value: string) => {
        const existing = glyphTextures.get(value);
        if (existing) return existing;
        const texture = makeGlyphTexture(three, value);
        glyphTextures.set(value, texture);
        return texture;
      };
      segments.forEach((segment, segmentIndex) => {
        const dx = segment.x2 - segment.x1;
        const dz = segment.z2 - segment.z1;
        const length = Math.hypot(dx, dz);
        const steps = Math.max(2, Math.ceil(length / 0.42));
        for (let step = 1; step < steps; step += 1) {
          const progress = step / steps;
          const glyph = glyphs[(segmentIndex + step) % glyphs.length];
          const material = addGlyph(
            three,
            glyphGroup,
            textureFor(glyph),
            segment.x1 + dx * progress,
            0.12 + seededNoise(segmentIndex * 20 + step) * (WALL_HEIGHT - 0.2),
            segment.z1 + dz * progress,
            0.18,
            0.48,
          );
          glyphMaterials.push(material);
        }
      });
      mazeGroup.add(glyphGroup);

      const markerTextures = new Map<string, Texture>();
      const markerMaterials: Array<InstanceType<typeof three.SpriteMaterial>> = [];
      const markerFor = (value: string) => {
        const existing = markerTextures.get(value);
        if (existing) return existing;
        const texture = makeGlyphTexture(three, value, value === "EXIT" ? 128 : 64);
        markerTextures.set(value, texture);
        return texture;
      };
      const start = cellCenter(maze, maze.start);
      const exit = cellCenter(maze, maze.exit);
      markerMaterials.push(addGlyph(three, mazeGroup, markerFor("W"), start.x, 0.86, start.z, 0.48, 0.92));
      markerMaterials.push(addGlyph(three, mazeGroup, markerFor("EXIT"), exit.x, 0.42, exit.z, 0.78, 0.72));

      const atmospherePositions: number[] = [];
      for (let index = 0; index < 90; index += 1) {
        const x = (seededNoise(index + 400) - 0.5) * (size + 2);
        const y = 0.18 + seededNoise(index + 500) * 1.6;
        const z = (seededNoise(index + 600) - 0.5) * (size + 2);
        atmospherePositions.push(x, y, z);
      }
      const atmosphereGeometry = new three.BufferGeometry();
      atmosphereGeometry.setAttribute("position", new three.Float32BufferAttribute(atmospherePositions, 3));
      const atmosphereMaterial = new three.PointsMaterial({
        color: 0x527ceb,
        size: 0.055,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        blending: three.AdditiveBlending,
      });
      const atmosphere = new three.Points(atmosphereGeometry, atmosphereMaterial);
      scene.add(atmosphere);

      stage.classList.add("is-ready");

      const resize = () => {
        const rect = stage.getBoundingClientRect();
        const width = Math.max(1, rect.width);
        const height = Math.max(1, rect.height);
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      };
      const observer = new ResizeObserver(resize);
      observer.observe(stage);
      resize();

      const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
      let reducedMotion = motionQuery.matches;
      controls.autoRotate = !reducedMotion;
      const onMotionChange = (event: MediaQueryListEvent) => {
        reducedMotion = event.matches;
        controls.autoRotate = !reducedMotion;
      };
      motionQuery.addEventListener("change", onMotionChange);

      let frameId = 0;
      const render = (time: number) => {
        if (disposed) return;
        controls.update();
        if (!reducedMotion) {
          const pulse = Math.sin(time * 0.0015) * 0.08;
          particleMaterial.opacity = 0.75 + pulse;
          atmosphereMaterial.opacity = 0.28 + pulse * 0.35;
          wallMaterial.uniforms.time.value = time * 0.001;
          atmosphere.rotation.y = time * 0.000025;
        }
        renderer.render(scene, camera);
        frameId = window.requestAnimationFrame(render);
      };
      frameId = window.requestAnimationFrame(render);

      cleanup = () => {
        window.cancelAnimationFrame(frameId);
        observer.disconnect();
        motionQuery.removeEventListener("change", onMotionChange);
        controls.dispose();
        wallGeometries.forEach((geometry) => geometry.dispose());
        wallMaterial.dispose();
        lineGeometry.dispose();
        lineMaterial.dispose();
        particleGeometry.dispose();
        particleMaterial.dispose();
        floor.geometry.dispose();
        (floor.material as InstanceType<typeof three.MeshBasicMaterial>).dispose();
        grid.geometry.dispose();
        gridMaterials.forEach((material) => material.dispose());
        glyphMaterials.forEach((material) => material.dispose());
        markerMaterials.forEach((material) => material.dispose());
        [...glyphTextures.values(), ...markerTextures.values()].forEach((texture) => texture.dispose());
        atmosphereGeometry.dispose();
        atmosphereMaterial.dispose();
        renderer.dispose();
        stage.classList.remove("is-ready");
        canvas.remove();
      };
    };

    void setup();
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [maze]);

  return (
    <div ref={stageRef} className="hero-maze-stage" aria-label="Interactive 3D maze. The camera auto-orbits while idle; drag to steer from the default top-down view.">
      {createFallback(maze)}
      <span className="sr-only">Interactive three-dimensional maze. The camera slowly orbits while idle; drag to steer it. The initial camera is a top-down view.</span>
    </div>
  );
}
