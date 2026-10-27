// Draws the prerequisite graph in 3D with three.js. Every course is one instance of a
// single sphere mesh and every link one segment of a single line object, so the whole
// galaxy is a handful of draw calls instead of one per planet and per line.
// Positions come precomputed from the import (graph_layout), so nothing is simulated here.

import { subjectHue } from "./graph-data.js";

const LINK_COLOR = "#6f7d99";
const NEEDS_COLOR = "#ffc46b"; // a link into the focused course: something it needs
const UNLOCKS_COLOR = "#7fb2ff"; // a link out of it: something it unlocks
// Planets for your own courses (the same colors as the My plan page).
const MARK_COLORS = { taken: "#4ade80", planned: "#60a5fa", ready: "#fbbf24" };
const FLY_MS = 1200;
const FADE_MS = 500;
const STAR_COUNT = 2500;
// The imported layout is a round ball. The page reshapes it into a spiral galaxy: stretched so
// lines are longer next to the planets (room to click), flattened into a disk, and swirled more
// the farther out a planet is. Nearby planets turn by about the same amount, so links stay short.
const SPREAD = 1.8;
const FLATTEN = 0.22; // the disk's thickness compared with its width
const SWIRL = 0.0016; // radians of turn per unit from the middle
// The overview looks at the disk from below and in front, so its shape shows.
const OVERVIEW_DIRECTION = [0, -0.6, 0.8];
const LINK_OPACITY = 0.09;
const FILTER_LINK_COLOR = "#9fb0d8";
const FILTER_LINK_OPACITY = 0.35;
const FOCUS_LINK_OPACITY = 0.9;
const MAX_LABELS = 60;
const PULSE_MS = 1800; // how long a light takes to travel one link
const HOVER_GROW = 1.35; // the planet under the pointer grows this much
const HOVER_GROW_MS = 150;
// If frames take longer than this on average, draw at a lower resolution to stay smooth.
const SLOW_FRAME_MS = 28;
const NEBULAS = [
  { rgb: "140, 100, 255", direction: [-0.6, 0.5, -0.6] },
  { rgb: "60, 140, 255", direction: [0.7, -0.2, -0.7] },
  { rgb: "255, 140, 90", direction: [0.2, -0.8, 0.5] },
  { rgb: "60, 200, 200", direction: [-0.5, -0.3, 0.8] },
];
// Instead of turning the whole galaxy, every planet floats on its own small loop and twinkles,
// and the links stretch to follow. The same formula runs on the graphics card (planets and
// lines, so it costs nothing per planet here) and in drift() below (labels, pulses, halo, picking).
// How far planets wander grows with the camera's distance, so the drift is clearly visible
// whether you are zoomed in on one course or looking at the whole galaxy.
const DRIFT_PER_DISTANCE = 0.018;
const DRIFT_MIN = 5;
const DRIFT_MAX = 90;
const DRIFT_GLSL = `
uniform float uTime;
uniform float uDriftAmount;
vec3 drift(vec3 p) {
  float seed = dot(p, vec3(0.013, 0.017, 0.011));
  return uDriftAmount * vec3(
    sin(uTime * 0.55 + seed * 7.0),
    sin(uTime * 0.47 + seed * 11.0),
    sin(uTime * 0.63 + seed * 5.0));
}
`;
// Courses at least this many others need decide the overview's framing.
const OVERVIEW_MIN_DEPENDENTS = 2;

/** Where a planet placed at p has floated to (matches DRIFT_GLSL, given the same uniforms). */
function drift(p, floating, out) {
  const time = floating.uTime.value;
  const amount = floating.uDriftAmount.value;
  const seed = p.x * 0.013 + p.y * 0.017 + p.z * 0.011;
  return out.set(
    p.x + amount * Math.sin(time * 0.55 + seed * 7),
    p.y + amount * Math.sin(time * 0.47 + seed * 11),
    p.z + amount * Math.sin(time * 0.63 + seed * 5),
  );
}

/** Turns a position from the round imported layout into the spiral-galaxy shape. */
function galaxyShape({ x, y, z }) {
  const [sx, sy, sz] = [x * SPREAD, y * SPREAD, z * SPREAD];
  const angle = Math.hypot(sx, sy) * SWIRL;
  return {
    x: sx * Math.cos(angle) - sy * Math.sin(angle),
    y: sx * Math.sin(angle) + sy * Math.cos(angle),
    z: sz * FLATTEN,
  };
}

function planetRadius(node) {
  return 4 * Math.cbrt(1 + node.dependents.length * 3);
}

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** A soft round light in one color ("r, g, b"), drawn once on a small canvas. */
function softTexture(THREE, rgb) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const context = canvas.getContext("2d");
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, `rgba(${rgb}, 0.9)`);
  gradient.addColorStop(0.3, `rgba(${rgb}, 0.35)`);
  gradient.addColorStop(1, `rgba(${rgb}, 0)`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(canvas);
}

/**
 * Lambert shading plus a soft rim in the planet's own color, like an atmosphere; each planet
 * also floats (DRIFT_GLSL) and slowly twinkles. These are a few lines added to the planets'
 * existing shader, so they cost no extra drawing.
 */
function planetMaterial(THREE, floating) {
  const material = new THREE.MeshLambertMaterial();
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, floating);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>${DRIFT_GLSL}varying float vTwinkle;`)
      .replace(
        "#include <project_vertex>",
        `vec4 mvPosition = vec4(transformed, 1.0);
        vec3 center = vec3(0.0);
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
          center = instanceMatrix[3].xyz;
        #endif
        mvPosition.xyz += drift(center);
        vTwinkle = 0.8 + 0.2 * sin(uTime * 1.6 + dot(center, vec3(0.031, 0.023, 0.037)) * 13.0);
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vTwinkle;")
      .replace(
        "#include <opaque_fragment>",
        `float rim = 1.0 - max(dot(normal, normalize(vViewPosition)), 0.0);
        outgoingLight += diffuseColor.rgb * pow(rim, 2.5) * 1.1;
        outgoingLight *= vTwinkle;
        #include <opaque_fragment>`,
      );
  };
  return material;
}

/** Line material whose ends float with the planets they join. */
function driftingLines(THREE, floating, parameters) {
  const material = new THREE.LineBasicMaterial(parameters);
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, floating);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>${DRIFT_GLSL}`)
      .replace("#include <project_vertex>", "transformed += drift(transformed);\n#include <project_vertex>");
  };
  return material;
}

/**
 * @param {HTMLElement} container where the canvas goes
 * @param {{ nodes, links, byId }} graph from buildGraph
 * @param {Map<string, {x, y, z}>} layout positions from graph_layout
 * @param {{ onSelect: (id: string) => void }} callbacks clicking a planet
 */
export async function createGalaxy(container, graph, layout, { onSelect }) {
  const positions = new Map([...layout].map(([id, p]) => [id, galaxyShape(p)]));
  const THREE = await import("three");
  const { OrbitControls } = await import("three/addons/controls/OrbitControls.js");

  // Shared by every floating material: seconds since the page opened, and how far planets wander.
  const floating = { uTime: { value: 0 }, uDriftAmount: { value: DRIFT_MIN } };
  const nodes = graph.nodes.filter((node) => positions.has(node.id));
  const indexOf = new Map(nodes.map((node, i) => [node.id, i]));

  // Transparent, so the page's own deep-space gradient shows behind the planets.
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); // throws without WebGL
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.domElement.className = "galaxy-canvas";
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 1, 30000);
  scene.add(camera);
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const light = new THREE.DirectionalLight(0xffffff, 1.6);
  light.position.set(1, 1, 2);
  camera.add(light); // light comes from the viewer, so planets look lit from the front

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  // ---- Planets: one instanced mesh; hiding a planet means shrinking it to nothing ----
  const planets = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, 18, 14),
    planetMaterial(THREE, floating),
    nodes.length,
  );
  const radii = nodes.map(planetRadius);
  const scales = Float32Array.from(radii); // what is drawn now
  let fromScales = Float32Array.from(radii); // where the current fade started
  let toScales = Float32Array.from(radii); // where it ends
  let fadeStart = null;
  let opacityFades = []; // { object, from, to } for the link layers and the halo

  const matrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  const place = new THREE.Vector3();
  const size = new THREE.Vector3();
  let hoverIndex = -1;
  let hoverGrow = 1; // eases up to HOVER_GROW while a planet is under the pointer
  function writeInstance(i) {
    const { x, y, z } = positions.get(nodes[i].id);
    const s = scales[i] * (i === hoverIndex ? hoverGrow : 1);
    matrix.compose(place.set(x, y, z), rotation, size.set(s, s, s));
    planets.setMatrixAt(i, matrix);
  }
  function writeMatrices() {
    for (let i = 0; i < nodes.length; i++) writeInstance(i);
    planets.instanceMatrix.needsUpdate = true;
  }
  function setHover(index) {
    if (index === hoverIndex) return;
    const previous = hoverIndex;
    hoverIndex = index;
    hoverGrow = 1;
    if (previous >= 0) writeInstance(previous);
    planets.instanceMatrix.needsUpdate = true;
  }
  writeMatrices();
  planets.computeBoundingSphere();
  scene.add(planets);

  // ---- Links: all of them faintly, plus the focused course's own in color ----
  const linkPairs = graph.links.filter((link) => indexOf.has(link.source) && indexOf.has(link.target));
  const segmentPositions = (pairs) => {
    const array = new Float32Array(pairs.length * 6);
    pairs.forEach((link, i) => {
      const a = positions.get(link.source);
      const b = positions.get(link.target);
      array.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6);
    });
    return new THREE.BufferAttribute(array, 3);
  };
  const allLinksGeometry = new THREE.BufferGeometry();
  allLinksGeometry.setAttribute("position", segmentPositions(linkPairs));
  const allLinks = new THREE.LineSegments(
    allLinksGeometry,
    driftingLines(THREE, floating, { color: LINK_COLOR, transparent: true, opacity: LINK_OPACITY, depthWrite: false }),
  );
  scene.add(allLinks);

  const focusLinks = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    driftingLines(THREE, floating, { vertexColors: true, transparent: true, opacity: 0, depthWrite: false }),
  );
  scene.add(focusLinks);

  // While filtering: only the links between courses that match.
  const filterLinks = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    driftingLines(THREE, floating, { color: FILTER_LINK_COLOR, transparent: true, opacity: 0, depthWrite: false }),
  );
  scene.add(filterLinks);

  // A soft glow around the focused planet that slowly breathes.
  const halo = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: softTexture(THREE, "255, 210, 150"),
      transparent: true,
      depthWrite: false,
      opacity: 0,
    }),
  );
  halo.visible = false;
  scene.add(halo);

  // Little lights travelling along the focused course's links, from prerequisite to course.
  const pulses = new THREE.Points(
    new THREE.BufferGeometry(),
    new THREE.PointsMaterial({
      size: 9,
      sizeAttenuation: false,
      map: softTexture(THREE, "255, 255, 255"),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      opacity: 0,
    }),
  );
  pulses.frustumCulled = false; // its points move every frame
  scene.add(pulses);
  let pulseLinks = []; // { from: Vector3, to: Vector3, offset }

  // A thin ring around the focused planet that slowly tilts.
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(1.7, 1.78, 96),
    new THREE.MeshBasicMaterial({
      color: "#ffe2b0",
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  scene.add(ring);

  // Faint colored clouds far behind the galaxy; they shift a little as the view turns.
  for (const { rgb, direction } of NEBULAS) {
    const cloud = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: softTexture(THREE, rgb), transparent: true, depthWrite: false, opacity: 0.22 }),
    );
    cloud.position
      .set(...direction)
      .normalize()
      .multiplyScalar(9000);
    cloud.scale.set(9000, 9000, 1);
    scene.add(cloud);
  }

  // ---- Stars far behind everything ----
  const starPositions = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i++) {
    const direction = new THREE.Vector3().randomDirection();
    direction.multiplyScalar(10000 + Math.random() * 8000);
    starPositions.set([direction.x, direction.y, direction.z], i * 3);
  }
  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
  scene.add(
    new THREE.Points(
      starGeometry,
      new THREE.PointsMaterial({ color: 0xffffff, size: 1.5, sizeAttenuation: false, transparent: true, opacity: 0.6 }),
    ),
  );

  // ---- Labels and legend for the focused course's neighborhood ----
  const labelLayer = document.createElement("div");
  labelLayer.className = "galaxy-labels";
  container.append(labelLayer);
  let labels = []; // { element, position, index }

  const legend = document.createElement("div");
  legend.className = "galaxy-legend";
  legend.hidden = true;
  legend.innerHTML =
    '<span><i style="background:' +
    NEEDS_COLOR +
    '"></i>needs</span>' +
    '<span><i style="background:' +
    UNLOCKS_COLOR +
    '"></i>unlocks</span>';
  container.append(legend);

  /** Labels the focused course and the most-needed of the kept courses. */
  function showLabels(focusedId, kept) {
    const importance = (id) => (id === focusedId ? Infinity : graph.byId.get(id).dependents.length);
    const ids = kept
      ? [...kept]
          .filter((id) => indexOf.has(id))
          .sort((a, b) => importance(b) - importance(a))
          .slice(0, MAX_LABELS)
      : [];
    labels = ids.map((id) => {
      const element = document.createElement("span");
      element.className = id === focusedId ? "galaxy-label focused" : "galaxy-label";
      element.textContent = id;
      element.style.opacity = "0"; // until the first frame places it
      const { x, y, z } = positions.get(id);
      return { element, position: new THREE.Vector3(x, y, z), index: indexOf.get(id) };
    });
    labelLayer.replaceChildren(...labels.map((label) => label.element));
  }

  const projected = new THREE.Vector3();
  const LABEL_HEIGHT = 16;
  const CHAR_WIDTH = 7.5;
  /** Places labels most-important first, skipping any that would overlap one already placed. */
  function moveLabels() {
    if (labels.length === 0) return;
    const width = container.clientWidth;
    const height = container.clientHeight;
    const placed = [];
    for (const label of labels) {
      drift(label.position, floating, projected).project(camera);
      const x = ((projected.x + 1) / 2) * width;
      const y = ((1 - projected.y) / 2) * height + 10 + LABEL_HEIGHT / 2;
      const halfWidth = (label.element.textContent.length * CHAR_WIDTH) / 2;
      const onScreen = projected.z < 1 && x > -halfWidth && x < width + halfWidth && y > 0 && y < height + LABEL_HEIGHT;
      const overlaps = placed.some(
        (p) => Math.abs(p.x - x) < p.halfWidth + halfWidth && Math.abs(p.y - y) < LABEL_HEIGHT,
      );
      const visible = onScreen && !overlaps;
      label.element.style.opacity = visible ? String(Math.min(1, scales[label.index] / radii[label.index])) : "0";
      if (!visible) continue;
      placed.push({ x, y, halfWidth });
      label.element.style.transform = `translate(${x.toFixed(1)}px, ${(y - LABEL_HEIGHT / 2).toFixed(1)}px) translateX(-50%)`;
    }
  }

  // ---- Colors, focus and filter ----
  const color = new THREE.Color();
  let focusPlace = null; // where the focused planet sits before floating
  /**
   * Keeps a focused course and its links, or the courses matching a filter, or everything,
   * and fades from what is shown now to that.
   */
  function paint(focusedId, highlighted, filtered, marks) {
    const kept = focusedId ? highlighted : filtered;
    nodes.forEach((node, i) => {
      if (node.id === focusedId) color.set("#ffffff");
      else if (marks.has(node.id)) color.set(MARK_COLORS[marks.get(node.id)]);
      else color.setHSL(subjectHue(node.subject) / 360, 0.8, 0.62);
      planets.setColorAt(i, color);
    });
    planets.instanceColor.needsUpdate = true;

    // Fade every other planet away, and every kept one (back) in.
    fromScales = Float32Array.from(scales);
    toScales = Float32Array.from(nodes, (node, i) => (!kept || kept.has(node.id) ? radii[i] : 0));

    const touching = focusedId
      ? linkPairs.filter((link) => link.source === focusedId || link.target === focusedId)
      : [];
    const needs = new THREE.Color(NEEDS_COLOR);
    const unlocks = new THREE.Color(UNLOCKS_COLOR);
    const colors = new Float32Array(touching.length * 6);
    touching.forEach((link, i) => {
      const c = link.target === focusedId ? needs : unlocks;
      colors.set([c.r, c.g, c.b, c.r, c.g, c.b], i * 6);
    });
    focusLinks.geometry.setAttribute("position", segmentPositions(touching));
    focusLinks.geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    focusLinks.geometry.computeBoundingSphere();

    const inside =
      !focusedId && filtered ? linkPairs.filter((link) => filtered.has(link.source) && filtered.has(link.target)) : [];
    filterLinks.geometry.setAttribute("position", segmentPositions(inside));
    filterLinks.geometry.computeBoundingSphere();

    if (focusedId) {
      const radius = planetRadius(graph.byId.get(focusedId));
      focusPlace = positions.get(focusedId);
      halo.userData.size = radius * 7;
      ring.scale.setScalar(radius);
    }

    const vector = (id) => {
      const p = positions.get(id);
      return new THREE.Vector3(p.x, p.y, p.z);
    };
    pulseLinks = touching.map((link) => ({
      from: vector(link.source),
      to: vector(link.target),
      offset: Math.random(),
    }));
    pulses.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(touching.length * 3), 3));
    const pulseColors = new Float32Array(touching.length * 3);
    touching.forEach((link, i) => pulseColors.set((link.target === focusedId ? needs : unlocks).toArray(), i * 3));
    pulses.geometry.setAttribute("color", new THREE.BufferAttribute(pulseColors, 3));
    const fade = (object, to) => ({ object, from: object.material.opacity, to });
    opacityFades = [
      fade(allLinks, kept ? 0 : LINK_OPACITY),
      fade(filterLinks, inside.length > 0 ? FILTER_LINK_OPACITY : 0),
      { object: focusLinks, from: 0, to: focusedId ? FOCUS_LINK_OPACITY : 0 },
      { object: halo, from: 0, to: focusedId ? 1 : 0 },
      { object: pulses, from: 0, to: focusedId ? 1 : 0 },
      { object: ring, from: 0, to: focusedId ? 0.5 : 0 },
    ];
    fadeStart = performance.now();

    legend.hidden = !focusedId;
    showLabels(focusedId, kept);
  }

  /** Steps the fade between what was shown and what is shown now. */
  function stepFade(now) {
    if (fadeStart === null) return;
    const k = easeInOut(Math.min(1, (now - fadeStart) / FADE_MS));
    for (let i = 0; i < scales.length; i++) scales[i] = fromScales[i] + (toScales[i] - fromScales[i]) * k;
    writeMatrices();
    for (const { object, from, to } of opacityFades) {
      object.material.opacity = from + (to - from) * k;
      object.visible = object.material.opacity > 0.001;
    }
    if (k === 1) fadeStart = null;
  }

  // ---- Camera ----
  let flight = null; // { from, to, fromTarget, toTarget, start }
  function flyCamera(toPosition, toTarget) {
    flight = {
      from: camera.position.clone(),
      to: toPosition,
      fromTarget: controls.target.clone(),
      toTarget,
      start: performance.now(),
    };
  }

  const overviewDirection = new THREE.Vector3(...OVERVIEW_DIRECTION).normalize();
  const fitDistance = (radius) => (radius / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.15;

  function overviewDistance() {
    const core = nodes.filter((node) => node.dependents.length >= OVERVIEW_MIN_DEPENDENTS);
    const distances = (core.length > 0 ? core : nodes)
      .map((node) => {
        const { x, y, z } = positions.get(node.id);
        return Math.hypot(x, y, z);
      })
      .sort((a, b) => a - b);
    return fitDistance(distances[Math.floor(distances.length * 0.9)] ?? 500);
  }

  function showOverview() {
    // A little farther than the fit, since the tilted disk looks taller than it is wide.
    flyCamera(overviewDirection.clone().multiplyScalar(overviewDistance() * 1.15), new THREE.Vector3(0, 0, 0));
  }

  /** Frames a set of courses: aims at their middle and backs off to fit most of them. */
  function frameCourses(ids) {
    const points = [...ids].map((id) => positions.get(id)).filter(Boolean);
    if (points.length === 0) return;
    const middle = new THREE.Vector3();
    for (const p of points) middle.add(new THREE.Vector3(p.x, p.y, p.z));
    middle.divideScalar(points.length);
    const distances = points
      .map((p) => Math.hypot(p.x - middle.x, p.y - middle.y, p.z - middle.z))
      .sort((a, b) => a - b);
    const reach = (distances[Math.floor(distances.length * 0.9)] ?? 0) + 30;
    const direction = camera.position.clone().sub(controls.target).normalize();
    if (direction.lengthSq() === 0) direction.set(0, 0, 1);
    flyCamera(middle.clone().add(direction.multiplyScalar(Math.max(160, fitDistance(reach)))), middle);
  }

  /** Centers a course and backs off far enough to see every course linked to it. */
  function flyTo(id, highlighted) {
    const center = positions.get(id);
    const target = new THREE.Vector3(center.x, center.y, center.z);
    let reach = 6 * planetRadius(graph.byId.get(id));
    for (const other of highlighted) {
      const p = positions.get(other);
      if (p) reach = Math.max(reach, Math.hypot(p.x - center.x, p.y - center.y, p.z - center.z) + 10);
    }
    // Come in from the current viewing direction.
    const direction = camera.position.clone().sub(controls.target).normalize();
    if (direction.lengthSq() === 0) direction.set(0, 0, 1);
    flyCamera(target.clone().add(direction.multiplyScalar(Math.max(160, fitDistance(reach)))), target);
  }

  // ---- Clicking and hovering ----
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const floated = new THREE.Vector3();
  /** The nearest visible planet under the pointer, where it has floated to right now. */
  function planetAt(event) {
    const box = renderer.domElement.getBoundingClientRect();
    pointer.set(((event.clientX - box.left) / box.width) * 2 - 1, -((event.clientY - box.top) / box.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const { ray } = raycaster;
    let best = null;
    let bestDistance = Infinity;
    nodes.forEach((node, i) => {
      if (toScales[i] === 0) return; // hidden
      const radius = scales[i] * (i === hoverIndex ? hoverGrow : 1);
      drift(positions.get(node.id), floating, floated);
      if (ray.distanceSqToPoint(floated) > radius * radius) return;
      const distance = floated.distanceTo(ray.origin);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = node;
      }
    });
    return best;
  }

  const tooltip = document.createElement("div");
  tooltip.className = "galaxy-tooltip";
  tooltip.hidden = true;
  container.append(tooltip);

  let downAt = null;
  renderer.domElement.addEventListener("pointerdown", (event) => {
    downAt = { x: event.clientX, y: event.clientY };
  });
  renderer.domElement.addEventListener("pointerup", (event) => {
    // A click on a planet, not the end of a drag. Empty space does nothing; going back is a button.
    if (!downAt || Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > 5) return;
    const node = planetAt(event);
    if (node) onSelect(node.id);
  });

  let hoverPending = false;
  renderer.domElement.addEventListener("pointermove", (event) => {
    if (hoverPending) return;
    hoverPending = true;
    requestAnimationFrame(() => {
      hoverPending = false;
      const node = planetAt(event);
      setHover(node ? indexOf.get(node.id) : -1);
      renderer.domElement.style.cursor = node ? "pointer" : "grab";
      tooltip.hidden = !node;
      if (!node) return;
      tooltip.textContent = `${node.id}: ${node.title} · needed by ${node.dependents.length}`;
      const box = container.getBoundingClientRect();
      tooltip.style.left = `${event.clientX - box.left + 14}px`;
      tooltip.style.top = `${event.clientY - box.top + 14}px`;
    });
  });
  renderer.domElement.addEventListener("pointerleave", () => {
    setHover(-1);
    tooltip.hidden = true;
  });

  // ---- Size and drawing loop ----
  function resize() {
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width === 0 || height === 0) return;
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);
  resize();

  const pulseFrom = new THREE.Vector3();
  const pulseTo = new THREE.Vector3();
  /** Moves each pulse along its link. */
  function movePulses(now) {
    if (!pulses.visible || pulseLinks.length === 0) return;
    const array = pulses.geometry.attributes.position.array;
    pulseLinks.forEach(({ from, to, offset }, i) => {
      const t = (now / PULSE_MS + offset) % 1;
      place.lerpVectors(drift(from, floating, pulseFrom), drift(to, floating, pulseTo), t);
      array.set([place.x, place.y, place.z], i * 3);
    });
    pulses.geometry.attributes.position.needsUpdate = true;
  }

  // Watches the frame time for a few seconds; on a slow computer, drops to a lower resolution.
  let lastFrame = null;
  const slowCheck = { frames: 0, total: 0, done: false };
  function checkSpeed(dt) {
    if (slowCheck.done || dt > 200) return; // a long gap means the page was hidden, not slow
    slowCheck.frames += 1;
    slowCheck.total += dt;
    if (slowCheck.frames < 120) return;
    slowCheck.done = true;
    if (slowCheck.total / slowCheck.frames > SLOW_FRAME_MS && renderer.getPixelRatio() > 1) {
      renderer.setPixelRatio(1);
      resize();
    }
  }

  let running = false;
  function frame(now) {
    if (!running) return;
    const dt = lastFrame === null ? 16 : now - lastFrame;
    lastFrame = now;
    floating.uTime.value = now / 1000;
    floating.uDriftAmount.value = THREE.MathUtils.clamp(
      camera.position.distanceTo(controls.target) * DRIFT_PER_DISTANCE,
      DRIFT_MIN,
      DRIFT_MAX,
    );
    checkSpeed(dt);
    if (hoverIndex >= 0 && hoverGrow < HOVER_GROW) {
      hoverGrow = Math.min(HOVER_GROW, hoverGrow + ((HOVER_GROW - 1) * dt) / HOVER_GROW_MS);
      writeInstance(hoverIndex);
      planets.instanceMatrix.needsUpdate = true;
    }
    if (flight) {
      const t = Math.min(1, (now - flight.start) / FLY_MS);
      const k = easeInOut(t);
      camera.position.lerpVectors(flight.from, flight.to, k);
      controls.target.lerpVectors(flight.fromTarget, flight.toTarget, k);
      if (t === 1) flight = null;
    }
    stepFade(now);
    if (focusPlace) {
      drift(focusPlace, floating, halo.position);
      ring.position.copy(halo.position);
    }
    if (halo.visible) {
      // A slow breath, about one every four seconds.
      const s = halo.userData.size * (1 + 0.08 * Math.sin(now / 650));
      halo.scale.set(s, s, 1);
    }
    if (ring.visible) {
      ring.rotation.set(1.2 + 0.15 * Math.sin(now / 3000), now / 6000, 0);
    }
    movePulses(now);
    controls.update();
    renderer.render(scene, camera);
    moveLabels();
    requestAnimationFrame(frame);
  }

  camera.position.copy(overviewDirection).multiplyScalar(overviewDistance() * 1.6); // start far out, then glide in
  paint(null, new Set(), null, new Map());

  return {
    /**
     * Shows only a focused course and its links, or else only the courses in `filtered`
     * (a Set, or null for all), and flies the camera to them. `marks` colors your own
     * courses: a Map from course id to "taken", "planned" or "ready". `keepCamera` repaints in place.
     */
    show({ focusedId = null, highlighted = new Set(), filtered = null, marks = new Map(), keepCamera = false }) {
      const known = Boolean(focusedId && positions.has(focusedId));
      paint(known ? focusedId : null, highlighted, filtered, marks);
      if (keepCamera) return; // only the colors changed
      if (known) flyTo(focusedId, highlighted);
      else if (filtered && filtered.size > 0) frameCourses(filtered);
      else showOverview();
    },
    has: (id) => positions.has(id),
    start() {
      if (running) return;
      running = true;
      resize();
      requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      lastFrame = null;
    },
  };
}
