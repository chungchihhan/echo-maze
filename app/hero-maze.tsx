"use client";

import { useEffect, useRef } from "react";
import type { Group, Texture } from "three";
import { shortestPath } from "../lib/maze/index.js";
import type { Maze } from "../lib/maze/types.js";

type WallSegment = { x1: number; z1: number; x2: number; z2: number };

const WALL_HEIGHT = 1.16;
const WALL_THICKNESS = 0.085;
const WALL_STEP = 0.12;
const WALL_LEVELS = 11;
const ICE = "#f0f7ff";
const WALKER_HEIGHT = 0.34;
const WALKER_COLOR = "#ff5c35";
const WALKER_PARTICLE_COUNT = 420;
const WALKER_PARTICLE_RADIUS = 0.3;
const WALKER_GLYPH_COUNT = 18;
const ENTRY_RISE_MS = 620;
const START_HOLD_MS = 900;
const MOVE_MS_PER_CELL = 560;
const EXIT_DROP_MS = 720;
const EXIT_HOLD_MS = 900;
const EXIT_RADIUS = 0.34;
const EXIT_DROP_DISTANCE = 0.48;

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
      <circle cx={maze.exit.c + 0.5} cy={maze.exit.r + 0.5} r=".2" fill="none" stroke="currentColor" strokeWidth=".055" />
      <circle cx={maze.exit.c + 0.5} cy={maze.exit.r + 0.5} r=".07" fill="currentColor" opacity=".72" />
    </svg>
  );
}

function makeGlyphTexture(three: typeof import("three"), value: string, size = 64, fillStyle = ICE): Texture {
  const surface = document.createElement("canvas");
  surface.width = size;
  surface.height = size;
  const context = surface.getContext("2d");
  if (context) {
    context.clearRect(0, 0, size, size);
    context.fillStyle = fillStyle;
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
  color = ICE,
) {
  const material = new three.SpriteMaterial({
    map: texture,
    color,
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

export function HeroMaze({ mazes }: { mazes: readonly Maze[] }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const fallbackMaze = mazes[0]!;

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || mazes.length === 0) return;

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
      const size = mazes[0].cells.length;
      const scene = new three.Scene();
      const baseCameraFov = 42;
      const heroContentWidth = 640;
      const camera = new three.PerspectiveCamera(baseCameraFov, 1, 0.1, 100);
      // Start at a 45-degree elevation so the maze reads as a space, not a flat plan.
      camera.position.set(11, 15.5, 11);

      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      renderer.setClearColor(0x0033e5, 0);
      renderer.outputColorSpace = three.SRGBColorSpace;
      renderer.autoClear = false;

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
      const wallGeometry = new three.BoxGeometry(1, WALL_HEIGHT, WALL_THICKNESS);
      const lineMaterial = new three.LineBasicMaterial({ color: ICE, transparent: true, opacity: 0.72, depthWrite: false });
      const particleMaterial = new three.PointsMaterial({
        color: ICE,
        size: 0.06,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.75,
        depthWrite: false,
        blending: three.AdditiveBlending,
      });
      const glyphTextures = new Map<string, Texture>();
      const glyphMaterials: Array<InstanceType<typeof three.SpriteMaterial>> = [];
      const glyphs = ["@", "·", "+", "x", "/", "#", ":"];
      const textureFor = (value: string) => {
        const existing = glyphTextures.get(value);
        if (existing) return existing;
        const texture = makeGlyphTexture(three, value);
        glyphTextures.set(value, texture);
        return texture;
      };
      const lineGeometries: Array<InstanceType<typeof three.BufferGeometry>> = [];
      const particleGeometries: Array<InstanceType<typeof three.BufferGeometry>> = [];
      const exitRingGeometry = new three.RingGeometry(EXIT_RADIUS * 0.66, EXIT_RADIUS, 40);
      const exitRingMaterial = new three.MeshBasicMaterial({
        color: ICE,
        transparent: true,
        opacity: 0.88,
        side: three.DoubleSide,
        depthWrite: false,
      });
      const exitCoreGeometry = new three.RingGeometry(EXIT_RADIUS * 0.2, EXIT_RADIUS * 0.3, 32);
      const exitCoreMaterial = new three.MeshBasicMaterial({
        color: ICE,
        transparent: true,
        opacity: 0.68,
        side: three.DoubleSide,
        depthWrite: false,
      });
      const exitParticlePositions: number[] = [];
      for (let index = 0; index < 48; index += 1) {
        const angle = (index / 48) * Math.PI * 2;
        for (const radius of [EXIT_RADIUS * 0.48, EXIT_RADIUS * 0.84]) {
          exitParticlePositions.push(Math.cos(angle) * radius, 0.012, Math.sin(angle) * radius);
        }
      }
      const exitParticleGeometry = new three.BufferGeometry();
      exitParticleGeometry.setAttribute("position", new three.Float32BufferAttribute(exitParticlePositions, 3));
      const exitParticleMaterial = new three.PointsMaterial({
        color: ICE,
        size: 0.045,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.82,
        depthWrite: false,
        blending: three.NormalBlending,
      });

      const buildMazeScene = (maze: Maze, mazeIndex: number) => {
        const group = new three.Group();
        group.visible = mazeIndex === 0;
        scene.add(group);
        const segments = getWallSegments(maze);
        const start = cellCenter(maze, maze.start);
        const exit = cellCenter(maze, maze.exit);

        const wallInstances = new three.InstancedMesh(wallGeometry, wallMaterial, segments.length);
        const wallTransform = new three.Object3D();
        segments.forEach((segment, segmentIndex) => {
          const horizontal = Math.abs(segment.x2 - segment.x1) > Math.abs(segment.z2 - segment.z1);
          const length = horizontal ? Math.abs(segment.x2 - segment.x1) : Math.abs(segment.z2 - segment.z1);
          wallTransform.position.set((segment.x1 + segment.x2) / 2, WALL_HEIGHT / 2, (segment.z1 + segment.z2) / 2);
          wallTransform.rotation.set(0, horizontal ? 0 : Math.PI / 2, 0);
          wallTransform.scale.set(length, 1, 1);
          wallTransform.updateMatrix();
          wallInstances.setMatrixAt(segmentIndex, wallTransform.matrix);
        });
        wallInstances.instanceMatrix.needsUpdate = true;
        group.add(wallInstances);

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
        lineGeometries.push(lineGeometry);
        group.add(new three.LineSegments(lineGeometry, lineMaterial));

        const particlePositions: number[] = [];
        let particleIndex = mazeIndex * 10000;
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
        particleGeometries.push(particleGeometry);
        group.add(new three.Points(particleGeometry, particleMaterial));

        const glyphGroup = new three.Group();
        segments.forEach((segment, segmentIndex) => {
          const dx = segment.x2 - segment.x1;
          const dz = segment.z2 - segment.z1;
          const length = Math.hypot(dx, dz);
          const steps = Math.max(2, Math.ceil(length / 0.42));
          for (let step = 1; step < steps; step += 1) {
            const progress = step / steps;
            const glyph = glyphs[(segmentIndex + step) % glyphs.length];
            glyphMaterials.push(addGlyph(
              three,
              glyphGroup,
              textureFor(glyph),
              segment.x1 + dx * progress,
              0.12 + seededNoise(mazeIndex * 1000 + segmentIndex * 20 + step) * (WALL_HEIGHT - 0.2),
              segment.z1 + dz * progress,
              0.18,
              0.48,
            ));
          }
        });
        group.add(glyphGroup);

        const exitMarker = new three.Group();
        const exitRing = new three.Mesh(exitRingGeometry, exitRingMaterial);
        exitRing.rotation.x = -Math.PI / 2;
        exitMarker.add(exitRing);
        const exitCore = new three.Mesh(exitCoreGeometry, exitCoreMaterial);
        exitCore.rotation.x = -Math.PI / 2;
        exitMarker.add(exitCore);
        exitMarker.add(new three.Points(exitParticleGeometry, exitParticleMaterial));
        glyphMaterials.push(addGlyph(
          three,
          exitMarker,
          textureFor("EXIT"),
          0,
          0.09,
          0,
          0.26,
          0.9,
        ));
        exitMarker.position.set(exit.x, 0.02, exit.z);
        group.add(exitMarker);

        const walkerPath = shortestPath(maze.cells, maze.start, maze.exit).map((point) => cellCenter(maze, point));
        const travelDuration = Math.max(0, walkerPath.length - 1) * MOVE_MS_PER_CELL;
        const travelStart = ENTRY_RISE_MS + START_HOLD_MS;
        const dropStart = travelStart + travelDuration;
        return {
          group,
          start,
          exit,
          walkerPath,
          travelDuration,
          travelStart,
          dropStart,
          animationDuration: dropStart + EXIT_DROP_MS + EXIT_HOLD_MS,
        };
      };

      const firstMaze = buildMazeScene(mazes[0], 0);
      const mazeScenes = new Map<number, typeof firstMaze>([[0, firstMaze]]);
      let preloadHandle: number | null = null;
      let preloadUsesIdleCallback = false;
      const schedulePreload = (mazeIndex: number) => {
        if (mazeIndex >= mazes.length || disposed) return;
        const preload = () => {
          preloadHandle = null;
          if (disposed) return;
          if (!mazeScenes.has(mazeIndex)) mazeScenes.set(mazeIndex, buildMazeScene(mazes[mazeIndex], mazeIndex));
          schedulePreload(mazeIndex + 1);
        };
        if (typeof window.requestIdleCallback === "function") {
          preloadUsesIdleCallback = true;
          preloadHandle = window.requestIdleCallback(preload, { timeout: 1800 });
        } else {
          preloadUsesIdleCallback = false;
          preloadHandle = window.setTimeout(preload, 180);
        }
      };
      schedulePreload(1);

      const walkerParticlePositions: number[] = [];
      for (let index = 0; index < WALKER_PARTICLE_COUNT; index += 1) {
        const progress = (index + 0.5) / WALKER_PARTICLE_COUNT;
        const y = 1 - progress * 2;
        const radius = Math.sqrt(1 - y * y);
        const angle = index * Math.PI * (3 - Math.sqrt(5));
        const surfaceRadius = WALKER_PARTICLE_RADIUS * (0.94 + seededNoise(index + 900) * 0.08);
        walkerParticlePositions.push(
          Math.cos(angle) * radius * surfaceRadius,
          y * surfaceRadius,
          Math.sin(angle) * radius * surfaceRadius,
        );
      }
      const walkerParticleGeometry = new three.BufferGeometry();
      walkerParticleGeometry.setAttribute("position", new three.Float32BufferAttribute(walkerParticlePositions, 3));
      const walkerParticleMaterial = new three.PointsMaterial({
        color: WALKER_COLOR,
        size: 0.055,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.96,
        depthWrite: false,
        blending: three.NormalBlending,
      });
      const walkerObject = new three.Group();
      const walkerRollGroup = new three.Group();
      const walkerParticles = new three.Points(walkerParticleGeometry, walkerParticleMaterial);
      walkerRollGroup.add(walkerParticles);
      const walkerGlyphGroup = new three.Group();
      const walkerGlyphTextures = new Map<string, Texture>();
      const walkerTextureFor = (value: string) => {
        const existing = walkerGlyphTextures.get(value);
        if (existing) return existing;
        const texture = makeGlyphTexture(three, value, 64, WALKER_COLOR);
        walkerGlyphTextures.set(value, texture);
        glyphTextures.set(`walker-${value}`, texture);
        return texture;
      };
      const walkerGlyphMaterials: Array<InstanceType<typeof three.SpriteMaterial>> = [];
      for (let index = 0; index < WALKER_GLYPH_COUNT; index += 1) {
        const progress = (index + 0.5) / WALKER_GLYPH_COUNT;
        const y = 1 - progress * 2;
        const radius = Math.sqrt(1 - y * y);
        const angle = index * Math.PI * (3 - Math.sqrt(5)) + 0.4;
        const glyphMaterial = addGlyph(
          three,
          walkerGlyphGroup,
          walkerTextureFor(glyphs[(index * 3) % glyphs.length]),
          Math.cos(angle) * radius * WALKER_PARTICLE_RADIUS * 1.02,
          y * WALKER_PARTICLE_RADIUS * 1.02,
          Math.sin(angle) * radius * WALKER_PARTICLE_RADIUS * 1.02,
          0.1,
          0.68,
          "#ffffff",
        );
        walkerGlyphMaterials.push(glyphMaterial);
        glyphMaterials.push(glyphMaterial);
      }
      walkerRollGroup.add(walkerGlyphGroup);
      walkerObject.add(walkerRollGroup);
      walkerObject.position.set(firstMaze.start.x, WALKER_HEIGHT, firstMaze.start.z);
      scene.add(walkerObject);

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

      let canvasWidth = 1;
      let canvasHeight = 1;
      let sceneViewportWidth = 1;
      const resize = () => {
        const rect = stage.getBoundingClientRect();
        const width = Math.max(1, rect.width);
        const height = Math.max(1, rect.height);
        canvasWidth = width;
        canvasHeight = height;
        sceneViewportWidth = Math.min(width, heroContentWidth);
        renderer.setSize(width, height, false);
        camera.aspect = sceneViewportWidth / height;
        camera.fov = three.MathUtils.radToDeg(
          2 * Math.atan(Math.tan(three.MathUtils.degToRad(baseCameraFov / 2)) * (width / sceneViewportWidth)),
        );
        camera.updateProjectionMatrix();
      };
      const observer = new ResizeObserver(resize);
      observer.observe(stage);
      resize();

      const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
      let reducedMotion = motionQuery.matches;
      let walkerAnimationStart: number | null = null;
      let activeMazeIndex = 0;
      let walkerRollX = 0;
      let walkerRollZ = 0;
      let previousPathProgress: number | null = null;
      const resetWalkerRoll = () => {
        walkerRollX = 0;
        walkerRollZ = 0;
        previousPathProgress = null;
        walkerRollGroup.rotation.set(0, 0, 0);
      };
      controls.autoRotate = !reducedMotion;
      const onMotionChange = (event: MediaQueryListEvent) => {
        reducedMotion = event.matches;
        controls.autoRotate = !reducedMotion;
        walkerAnimationStart = null;
        mazeScenes.forEach((item, index) => { item.group.visible = index === 0; });
        activeMazeIndex = 0;
        walkerParticleMaterial.opacity = 0.96;
        walkerGlyphMaterials.forEach((material) => { material.opacity = 0.68; });
        resetWalkerRoll();
        walkerObject.position.set(firstMaze.start.x, WALKER_HEIGHT, firstMaze.start.z);
      };
      motionQuery.addEventListener("change", onMotionChange);

      let frameId = 0;
      let pageVisible = document.visibilityState === "visible";
      let stageVisible = true;
      let suspendedAt: number | null = null;
      const renderingShouldRun = () => pageVisible && stageVisible;
      const render = (time: number) => {
        frameId = 0;
        if (disposed) return;
        if (!renderingShouldRun()) {
          if (suspendedAt === null) suspendedAt = time;
          return;
        }
        controls.update();
        if (!reducedMotion) {
          if (walkerAnimationStart === null) walkerAnimationStart = time;
          let activeMaze = mazeScenes.get(activeMazeIndex)!;
          let elapsed = time - walkerAnimationStart;
          while (elapsed >= activeMaze.animationDuration) {
            const nextMazeIndex = (activeMazeIndex + 1) % mazes.length;
            const nextMaze = mazeScenes.get(nextMazeIndex);
            if (!nextMaze) {
              walkerAnimationStart = time - activeMaze.animationDuration;
              elapsed = activeMaze.animationDuration - 1;
              break;
            }
            walkerAnimationStart += activeMaze.animationDuration;
            activeMaze.group.visible = false;
            activeMazeIndex = nextMazeIndex;
            activeMaze = nextMaze;
            activeMaze.group.visible = true;
            resetWalkerRoll();
            elapsed = time - walkerAnimationStart;
          }
          if (elapsed < ENTRY_RISE_MS) {
            resetWalkerRoll();
            const entryProgress = elapsed / ENTRY_RISE_MS;
            const easedEntry = 1 - Math.pow(1 - entryProgress, 3);
            walkerParticleMaterial.opacity = easedEntry * 0.96;
            walkerGlyphMaterials.forEach((material) => { material.opacity = easedEntry * 0.68; });
            walkerObject.position.set(activeMaze.start.x, WALKER_HEIGHT - EXIT_DROP_DISTANCE * (1 - easedEntry), activeMaze.start.z);
          } else if (elapsed < activeMaze.travelStart || activeMaze.walkerPath.length < 2) {
            resetWalkerRoll();
            walkerParticleMaterial.opacity = 0.96;
            walkerGlyphMaterials.forEach((material) => { material.opacity = 0.68; });
            walkerObject.position.set(activeMaze.start.x, WALKER_HEIGHT, activeMaze.start.z);
          } else if (elapsed < activeMaze.dropStart) {
            walkerParticleMaterial.opacity = 0.96;
            walkerGlyphMaterials.forEach((material) => { material.opacity = 0.68; });
            const pathProgress = (elapsed - activeMaze.travelStart) / MOVE_MS_PER_CELL;
            const segmentIndex = Math.min(Math.floor(pathProgress), activeMaze.walkerPath.length - 2);
            const segmentProgress = pathProgress - segmentIndex;
            const easedProgress = segmentProgress * segmentProgress * (3 - 2 * segmentProgress);
            const from = activeMaze.walkerPath[segmentIndex];
            const to = activeMaze.walkerPath[segmentIndex + 1];
            if (previousPathProgress === null) previousPathProgress = pathProgress;
            let remainingProgress = Math.max(0, pathProgress - previousPathProgress);
            let rollProgress = previousPathProgress;
            while (remainingProgress > 0) {
              const rollSegmentIndex = Math.min(Math.floor(rollProgress), activeMaze.walkerPath.length - 2);
              const segmentEnd = Math.min(rollSegmentIndex + 1, activeMaze.walkerPath.length - 1);
              const segmentAdvance = Math.min(remainingProgress, segmentEnd - rollProgress);
              const rollFrom = activeMaze.walkerPath[rollSegmentIndex];
              const rollTo = activeMaze.walkerPath[rollSegmentIndex + 1];
              const directionX = rollTo.x - rollFrom.x;
              const directionZ = rollTo.z - rollFrom.z;
              walkerRollZ -= (directionX * segmentAdvance) / WALKER_PARTICLE_RADIUS;
              walkerRollX += (directionZ * segmentAdvance) / WALKER_PARTICLE_RADIUS;
              rollProgress += segmentAdvance;
              remainingProgress -= segmentAdvance;
            }
            previousPathProgress = pathProgress;
            walkerRollGroup.rotation.x = walkerRollX;
            walkerRollGroup.rotation.z = walkerRollZ;
            walkerObject.position.set(
              from.x + (to.x - from.x) * easedProgress,
              WALKER_HEIGHT + Math.sin(segmentProgress * Math.PI) * 0.045,
              from.z + (to.z - from.z) * easedProgress,
            );
          } else {
            const dropProgress = Math.min(1, (elapsed - activeMaze.dropStart) / EXIT_DROP_MS);
            const easedDrop = dropProgress * dropProgress;
            const walkerOpacity = 1 - Math.max(0, (dropProgress - 0.55) / 0.45);
            walkerParticleMaterial.opacity = walkerOpacity * 0.96;
            walkerGlyphMaterials.forEach((material) => { material.opacity = walkerOpacity * 0.68; });
            walkerObject.position.set(activeMaze.exit.x, WALKER_HEIGHT - easedDrop * EXIT_DROP_DISTANCE, activeMaze.exit.z);
          }
          const pulse = Math.sin(time * 0.0015) * 0.08;
          particleMaterial.opacity = 0.75 + pulse;
          atmosphereMaterial.opacity = 0.28 + pulse * 0.35;
          wallMaterial.uniforms.time.value = time * 0.001;
          atmosphere.rotation.y = time * 0.000025;
        }
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, canvasWidth, canvasHeight);
        renderer.clear();
        renderer.setViewport(0, 0, sceneViewportWidth, canvasHeight);
        renderer.setScissor(0, 0, sceneViewportWidth, canvasHeight);
        renderer.setScissorTest(true);
        renderer.render(scene, camera);
        renderer.setScissorTest(false);
        frameId = window.requestAnimationFrame(render);
      };

      const stopRendering = () => {
        if (suspendedAt === null) suspendedAt = performance.now();
        if (frameId !== 0) {
          window.cancelAnimationFrame(frameId);
          frameId = 0;
        }
      };
      const startRendering = () => {
        if (!renderingShouldRun() || frameId !== 0) return;
        const resumedAt = performance.now();
        if (suspendedAt !== null) {
          if (walkerAnimationStart !== null) walkerAnimationStart += resumedAt - suspendedAt;
          suspendedAt = null;
        }
        frameId = window.requestAnimationFrame(render);
      };
      const onVisibilityChange = () => {
        pageVisible = document.visibilityState === "visible";
        if (pageVisible) startRendering();
        else stopRendering();
      };
      const visibilityObserver = typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(([entry]) => {
            stageVisible = entry?.isIntersecting ?? true;
            if (stageVisible) startRendering();
            else stopRendering();
          });

      document.addEventListener("visibilitychange", onVisibilityChange);
      visibilityObserver?.observe(stage);
      startRendering();

      cleanup = () => {
        window.cancelAnimationFrame(frameId);
        if (preloadHandle !== null) {
          if (preloadUsesIdleCallback) window.cancelIdleCallback(preloadHandle);
          else window.clearTimeout(preloadHandle);
        }
        observer.disconnect();
        visibilityObserver?.disconnect();
        document.removeEventListener("visibilitychange", onVisibilityChange);
        motionQuery.removeEventListener("change", onMotionChange);
        controls.dispose();
        wallGeometry.dispose();
        wallMaterial.dispose();
        lineGeometries.forEach((geometry) => geometry.dispose());
        lineMaterial.dispose();
        particleGeometries.forEach((geometry) => geometry.dispose());
        particleMaterial.dispose();
        grid.geometry.dispose();
        gridMaterials.forEach((material) => material.dispose());
        glyphMaterials.forEach((material) => material.dispose());
        walkerParticleGeometry.dispose();
        walkerParticleMaterial.dispose();
        exitRingGeometry.dispose();
        exitRingMaterial.dispose();
        exitCoreGeometry.dispose();
        exitCoreMaterial.dispose();
        exitParticleGeometry.dispose();
        exitParticleMaterial.dispose();
        [...glyphTextures.values()].forEach((texture) => texture.dispose());
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
  }, [mazes]);

  return (
    <div ref={stageRef} className="hero-maze-stage" aria-label="Interactive 3D maze. The camera auto-orbits while idle; drag to steer from the default angled view.">
      {createFallback(fallbackMaze)}
      <span className="sr-only">Interactive three-dimensional maze. The camera slowly orbits while idle; drag to steer it. The initial camera uses a 45-degree angled view.</span>
    </div>
  );
}
