// The home page's small 3D star map: one course, the courses it needs and the ones it unlocks,
// scattered at random and all drifting freely, joined by lines.
// About a dozen planets, so plain meshes are fine here (the big map needs instancing).

const NEEDS_COLOR = "#ffc46b";
const UNLOCKS_COLOR = "#7fb2ff";
const GROW_MS = 700; // a new course's planets grow in, one after another
const STAGGER_MS = 45;
const SHRINK_MS = 300; // the old ones shrink away first
const WANDER = 22; // how far a planet drifts from where it started
const FEATURED_SIZE = 9;
// Planets start somewhere inside this box (shallow, so they don't hide behind each other).
const BOX = { x: 72, y: 48, z: 20 };
const CANDIDATES = 25; // random spots tried per planet; the one farthest from the rest wins

const easeOut = (t) => 1 - (1 - t) ** 3;

/** A side planet's size: bigger when more courses need it. */
const planetSize = (neededBy) => 3 + 1.6 * Math.cbrt(neededBy);

/**
 * @param {HTMLElement} container where the canvas goes
 * @param {{ onSelect: (id: string) => void }} callbacks clicking a planet
 * @returns {Promise<{ show(course): void, start(): void, stop(): void }>}
 */
export async function createMiniMap(container, { onSelect }) {
  const THREE = await import("three");

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); // throws without WebGL
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 1, 2000);
  camera.position.set(0, 0, 240);
  scene.add(camera);
  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const light = new THREE.DirectionalLight(0xffffff, 1.6);
  light.position.set(1, 1, 2);
  camera.add(light);

  // Everything sways together a little, so the scene reads as 3D.
  const group = new THREE.Group();
  scene.add(group);
  const sphere = new THREE.SphereGeometry(1, 28, 20);
  const lines = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.75 }),
  );
  group.add(lines);

  const labelLayer = document.createElement("div");
  labelLayer.className = "mini-labels";
  container.append(labelLayer);

  let planets = []; // { id, mesh, label, home, phase, speed, size, bornAt, kind }
  let leaving = []; // planets of the previous course, shrinking away
  let leftAt = 0;

  function makePlanet({ id, hue, neededBy }, kind, home, order, now) {
    const mesh = new THREE.Mesh(
      sphere,
      new THREE.MeshLambertMaterial({
        color: new THREE.Color().setHSL(hue / 360, kind === "featured" ? 0.85 : 0.75, kind === "featured" ? 0.7 : 0.6),
        emissive: new THREE.Color().setHSL(hue / 360, 0.8, kind === "featured" ? 0.25 : 0.12),
      }),
    );
    mesh.scale.setScalar(0.001);
    mesh.userData.id = id;
    group.add(mesh);
    const label = document.createElement("span");
    label.className = `mini-label ${kind}`;
    label.textContent = id;
    labelLayer.append(label);
    return {
      id,
      mesh,
      label,
      home,
      kind,
      size: kind === "featured" ? FEATURED_SIZE : planetSize(neededBy),
      phase: [Math.random() * 6.3, Math.random() * 6.3, Math.random() * 6.3],
      speed: 0.12 + Math.random() * 0.18, // slow, and different for every planet
      bornAt: now + order * STAGGER_MS,
    };
  }

  /**
   * Random starting places inside BOX, spread evenly: each planet tries CANDIDATES random spots
   * and takes the one farthest from the planets already placed.
   */
  function scatter(count) {
    const homes = [];
    const random = (half) => (Math.random() * 2 - 1) * half;
    const nearest = (spot) => Math.min(Infinity, ...homes.map((home) => home.distanceTo(spot)));
    for (let i = 0; i < count; i++) {
      let best = null;
      for (let attempt = 0; attempt < CANDIDATES; attempt++) {
        const spot = new THREE.Vector3(random(BOX.x), random(BOX.y), random(BOX.z));
        if (!best || nearest(spot) > nearest(best)) best = spot;
      }
      homes.push(best);
    }
    return homes;
  }

  /**
   * Shows a new course.
   * @param {{ id, hue, neededBy, needs: {id, hue, neededBy}[], unlocks: {id, hue, neededBy}[] }} course
   */
  function show(course) {
    const now = performance.now();
    for (const old of leaving) dispose(old);
    leaving = planets;
    leftAt = now;
    const homes = scatter(1 + course.needs.length + course.unlocks.length);
    let order = 0;
    planets = [
      makePlanet(course, "featured", homes[order], order++, now),
      ...course.needs.map((c) => makePlanet(c, "needs", homes[order], order++, now)),
      ...course.unlocks.map((c) => makePlanet(c, "unlocks", homes[order], order++, now)),
    ];
  }

  function dispose(planet) {
    group.remove(planet.mesh);
    planet.mesh.material.dispose();
    planet.label.remove();
  }

  const projected = new THREE.Vector3();
  const needsColor = new THREE.Color(NEEDS_COLOR);
  const unlocksColor = new THREE.Color(UNLOCKS_COLOR);

  /** Moves every planet along its own wobbly path and redraws the lines to follow. */
  function step(now) {
    const time = now / 1000;
    group.rotation.y = 0.45 * Math.sin(time * 0.17);
    group.rotation.x = 0.15 * Math.sin(time * 0.13);

    for (const planet of planets) {
      planet.mesh.position.set(
        planet.home.x + WANDER * Math.sin(time * planet.speed + planet.phase[0]),
        planet.home.y + WANDER * Math.sin(time * planet.speed * 0.8 + planet.phase[1]),
        planet.home.z + WANDER * Math.sin(time * planet.speed * 1.2 + planet.phase[2]),
      );
      const grown = easeOut(Math.min(1, Math.max(0, (now - planet.bornAt) / GROW_MS)));
      planet.mesh.scale.setScalar(Math.max(0.001, planet.size * grown));
      planet.label.style.opacity = String(grown);
    }

    const shrink = 1 - easeOut(Math.min(1, (now - leftAt) / SHRINK_MS));
    for (const planet of leaving) {
      planet.mesh.scale.setScalar(Math.max(0.001, planet.size * shrink));
      planet.label.style.opacity = String(shrink);
    }
    if (shrink === 0 && leaving.length > 0) {
      leaving.forEach(dispose);
      leaving = [];
    }

    // One line from each linked course to the featured one.
    const [featured, ...sides] = planets;
    const positions = new Float32Array(sides.length * 6);
    const colors = new Float32Array(sides.length * 6);
    sides.forEach((planet, i) => {
      const a = planet.mesh.position;
      const b = featured.mesh.position;
      positions.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6);
      const c = planet.kind === "needs" ? needsColor : unlocksColor;
      const k = Math.min(planet.mesh.scale.x / planet.size, 1); // lines fade in with their planet
      colors.set([c.r * k, c.g * k, c.b * k, c.r * k, c.g * k, c.b * k], i * 6);
    });
    lines.geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    lines.geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    const width = container.clientWidth;
    const height = container.clientHeight;
    for (const planet of [...planets, ...leaving]) {
      planet.mesh.getWorldPosition(projected).project(camera);
      const x = ((projected.x + 1) / 2) * width;
      const y = ((1 - projected.y) / 2) * height;
      const below = planet.mesh.scale.x * 2 + 6; // just under the planet
      planet.label.style.transform = `translate(${x.toFixed(1)}px, ${(y + below).toFixed(1)}px) translateX(-50%)`;
    }
  }

  // ---- Clicking ----
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  function planetAt(event) {
    const box = renderer.domElement.getBoundingClientRect();
    pointer.set(((event.clientX - box.left) / box.width) * 2 - 1, -((event.clientY - box.top) / box.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const [hit] = raycaster.intersectObjects(planets.map((planet) => planet.mesh));
    return hit ? hit.object.userData.id : null;
  }
  renderer.domElement.addEventListener("click", (event) => {
    const id = planetAt(event);
    if (id) onSelect(id);
  });
  renderer.domElement.addEventListener("pointermove", (event) => {
    renderer.domElement.style.cursor = planetAt(event) ? "pointer" : "default";
  });

  // ---- Size and loop ----
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

  let running = false;
  function frame(now) {
    if (!running) return;
    if (planets.length > 0) step(now);
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }

  return {
    show,
    start() {
      if (running) return;
      running = true;
      resize();
      requestAnimationFrame(frame);
    },
    stop() {
      running = false;
    },
  };
}
