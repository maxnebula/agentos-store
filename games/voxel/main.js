/* Voxel World - A 3D block-building game using Three.js */

(function() {
  'use strict';

  if (typeof THREE === 'undefined') {
    document.getElementById('blocker').innerHTML =
      '<h1 style="color:#FF6B6B">Failed to load Three.js</h1>' +
      '<p style="color:#aaa">Check your internet connection and try again.</p>';
    return;
  }

  var WORLD_SIZE = 32;
  var PLAYER_SPEED = 5;
  var FLY_SPEED = 10;
  var GRAVITY = -20;
  var JUMP_SPEED = 8;
  var REACH = 6;
  var MOUSE_SENSITIVITY = 0.002;

  var BLOCKS = [
    { id: 'grass',  color: 0x4a8c3f, name: 'Grass' },
    { id: 'dirt',   color: 0x8B5A2B, name: 'Dirt' },
    { id: 'stone',  color: 0x808080, name: 'Stone' },
    { id: 'wood',   color: 0x6B4226, name: 'Wood' },
    { id: 'leaves', color: 0x2d8c2d, name: 'Leaves' },
    { id: 'sand',   color: 0xdbc9a0, name: 'Sand' },
    { id: 'brick',  color: 0xb85c38, name: 'Brick' },
  ];

  var world = {};
  var meshGroup = null;
  var scene, camera, renderer;

  var player = {
    pos: { x: WORLD_SIZE / 2, y: 20, z: WORLD_SIZE / 2 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    onGround: false,
    flying: true,
  };

  var keys = {};
  var isLocked = false;
  var selectedSlot = 0;
  var blockCount = 0;

  // Reusable objects for raycasting (avoid GC)
  var _rcBox = new THREE.Box3();
  var _rcTarget = new THREE.Vector3();
  var _rcOrigin = new THREE.Vector3();
  var _rcDir = new THREE.Vector3();
  var _rcEntry = new THREE.Vector3();
  var _rcLocal = new THREE.Vector3();

  // ============ Noise ============

  function hash(x, y) {
    var h = x * 374761393 + y * 668265263;
    h = (h ^ (h >> 13)) * 1274126177;
    return (h ^ (h >> 16)) & 0x7fffffff;
  }

  function smoothNoise(x, y) {
    var ix = Math.floor(x), iy = Math.floor(y);
    var fx = x - ix, fy = y - iy;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    var a = hash(ix, iy) / 0x7fffffff;
    var b = hash(ix + 1, iy) / 0x7fffffff;
    var c = hash(ix, iy + 1) / 0x7fffffff;
    var d = hash(ix + 1, iy + 1) / 0x7fffffff;
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }

  function noise2D(x, y, octaves) {
    var value = 0, amp = 1, freq = 1, total = 0;
    for (var i = 0; i < octaves; i++) {
      value += amp * smoothNoise(x * freq, y * freq);
      total += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return value / total;
  }

  function getHeight(x, z) {
    var h = noise2D(x / 20, z / 20, 4);
    return Math.floor(h * 8 + 10);
  }

  // ============ World Generation ============

  function key(x, y, z) {
    return x + ',' + y + ',' + z;
  }

  function setBlock(x, y, z, type) {
    if (y < 0 || y > 64) return;
    for (var i = 0; i < BLOCKS.length; i++) {
      if (BLOCKS[i].id === type) {
        world[key(x, y, z)] = i + 1;
        return;
      }
    }
  }

  function getBlock(x, y, z) {
    return world[key(x, y, z)] || 0;
  }

  function generateWorld() {
    var cx = WORLD_SIZE / 2;
    var cz = WORLD_SIZE / 2;

    for (var x = 0; x < WORLD_SIZE; x++) {
      for (var z = 0; z < WORLD_SIZE; z++) {
        var h = getHeight(x - cx, z - cz);
        var beach = h <= 1;

        for (var y = 0; y <= h; y++) {
          if (y === h) {
            setBlock(x, y, z, beach ? 'sand' : 'grass');
          } else if (y > h - 3) {
            setBlock(x, y, z, 'dirt');
          } else {
            setBlock(x, y, z, 'stone');
          }
        }

        // Trees
        if (!beach && h >= 3 && Math.random() < 0.03) {
          var trunk = 3 + Math.floor(Math.random() * 2);
          for (var ty = h + 1; ty <= h + trunk; ty++) setBlock(x, ty, z, 'wood');
          var ls = h + trunk - 1;
          for (var lx = -2; lx <= 2; lx++) {
            for (var lz = -2; lz <= 2; lz++) {
              for (var ly = 0; ly <= 2; ly++) {
                if (Math.abs(lx) + Math.abs(lz) + Math.abs(ly - 1) <= 3) {
                  setBlock(x + lx, ls + ly, z + lz, 'leaves');
                }
              }
            }
          }
        }
      }
    }
  }

  // ============ Rendering ============

  function hasExposedFace(x, y, z) {
    return getBlock(x + 1, y, z) === 0 ||
           getBlock(x - 1, y, z) === 0 ||
           getBlock(x, y + 1, z) === 0 ||
           getBlock(x, y - 1, z) === 0 ||
           getBlock(x, y, z + 1) === 0 ||
           getBlock(x, y, z - 1) === 0;
  }

  function mergeBoxes(positions) {
    var boxGeo = new THREE.BoxGeometry(0.98, 0.98, 0.98);
    var posAttr = boxGeo.getAttribute('position');
    var uvAttr = boxGeo.getAttribute('uv');
    var normAttr = boxGeo.getAttribute('normal');
    var verts = posAttr.count;
    var total = positions.length * verts;

    var pa = new Float32Array(total * 3);
    var ua = new Float32Array(total * 2);
    var na = new Float32Array(total * 3);
    var ia = [];

    for (var i = 0; i < positions.length; i++) {
      var p = positions[i];
      var off = i * verts * 3;
      var uoff = i * verts * 2;
      var idxOff = i * verts;

      for (var j = 0; j < verts; j++) {
        pa[off + j * 3]     = posAttr.getX(j) + p.x;
        pa[off + j * 3 + 1] = posAttr.getY(j) + p.y;
        pa[off + j * 3 + 2] = posAttr.getZ(j) + p.z;
        ua[uoff + j * 2]     = uvAttr.getX(j);
        ua[uoff + j * 2 + 1] = uvAttr.getY(j);
        na[off + j * 3]     = normAttr.getX(j);
        na[off + j * 3 + 1] = normAttr.getY(j);
        na[off + j * 3 + 2] = normAttr.getZ(j);
      }

      var idx = boxGeo.getIndex();
      for (var k = 0; k < idx.count; k++) {
        ia.push(idx.getX(k) + idxOff);
      }
    }

    boxGeo.dispose();

    var merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(pa, 3));
    merged.setAttribute('uv', new THREE.BufferAttribute(ua, 2));
    merged.setAttribute('normal', new THREE.BufferAttribute(na, 3));
    merged.setIndex(ia);
    merged.computeVertexNormals();
    return merged;
  }

  function rebuildMesh() {
    if (meshGroup) {
      scene.remove(meshGroup);
      meshGroup = null;
    }

    meshGroup = new THREE.Group();

    // Group visible blocks by type
    var byType = {};
    for (var k in world) {
      var id = world[k];
      if (!byType[id]) byType[id] = [];
      var p = k.split(',');
      byType[id].push({ x: parseInt(p[0]), y: parseInt(p[1]), z: parseInt(p[2]) });
    }

    for (var typeId in byType) {
      var positions = byType[typeId];
      var color = BLOCKS[parseInt(typeId) - 1].color;

      // Cull interior faces
      var visible = [];
      for (var i = 0; i < positions.length; i++) {
        var p = positions[i];
        if (hasExposedFace(p.x, p.y, p.z)) visible.push(p);
      }
      if (visible.length === 0) continue;

      var merged = mergeBoxes(visible);
      var material = new THREE.MeshLambertMaterial({ color: color });
      var mesh = new THREE.Mesh(merged, material);
      meshGroup.add(mesh);
    }

    scene.add(meshGroup);
  }

  // ============ Block Operations ============

  function removeBlock(x, y, z) {
    delete world[key(x, y, z)];
    rebuildMesh();
  }

  function placeBlock(x, y, z, typeId) {
    if (getBlock(x, y, z) !== 0) return;

    var px = Math.floor(player.pos.x);
    var py = Math.floor(player.pos.y);
    var pz = Math.floor(player.pos.z);
    if (x === px && Math.abs(y - py) <= 1 && z === pz) return;

    setBlock(x, y, z, BLOCKS[typeId].id);
    rebuildMesh();
    blockCount++;
    document.getElementById('blocks').textContent = blockCount;
  }

  // ============ Raycaster ============

  var raycaster = new THREE.Raycaster();
  raycaster.far = REACH;

  function getTargetBlock() {
    raycaster.setFromCamera({ x: 0, y: 0 }, camera);

    var closestDist = Infinity;
    var closestPos = null;
    var closestFace = null;

    _rcOrigin.copy(raycaster.ray.origin);
    _rcDir.copy(raycaster.ray.direction);

    for (var k in world) {
      var p = k.split(',');
      var bx = parseInt(p[0]), by = parseInt(p[1]), bz = parseInt(p[2]);

      _rcBox.min.set(bx, by, bz);
      _rcBox.max.set(bx + 1, by + 1, bz + 1);

      var hit = raycaster.ray.intersectsBox(_rcBox, _rcTarget);
      if (!hit) continue;

      var dist = _rcOrigin.distanceTo(_rcTarget);
      if (dist >= closestDist) continue;

      closestDist = dist;
      closestPos = { x: bx, y: by, z: bz };

      _rcEntry.copy(_rcTarget);
      _rcLocal.set(
        _rcEntry.x - bx - 0.5,
        _rcEntry.y - by - 0.5,
        _rcEntry.z - bz - 0.5
      );

      var ax = Math.abs(_rcLocal.x);
      var ay = Math.abs(_rcLocal.y);
      var az = Math.abs(_rcLocal.z);

      if (ax >= ay && ax >= az) {
        closestFace = { x: _rcLocal.x > 0 ? 1 : -1, y: 0, z: 0 };
      } else if (ay >= ax && ay >= az) {
        closestFace = { x: 0, y: _rcLocal.y > 0 ? 1 : -1, z: 0 };
      } else {
        closestFace = { x: 0, y: 0, z: _rcLocal.z > 0 ? 1 : -1 };
      }
    }

    return { pos: closestPos, face: closestFace };
  }

  // ============ Input ============

  document.getElementById('blocker').addEventListener('click', function() {
    renderer.domElement.requestPointerLock();
  });

  document.addEventListener('pointerlockchange', function() {
    isLocked = document.pointerLockElement === renderer.domElement;
    document.getElementById('blocker').classList.toggle('hidden', isLocked);
  });

  document.addEventListener('mousemove', function(e) {
    if (!isLocked) return;
    player.yaw -= e.movementX * MOUSE_SENSITIVITY;
    player.pitch -= e.movementY * MOUSE_SENSITIVITY;
    player.pitch = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, player.pitch));
  });

  document.addEventListener('keydown', function(e) {
    keys[e.key.toLowerCase()] = true;
    if (e.key === 'Escape' && isLocked) document.exitPointerLock();

    var n = parseInt(e.key, 10);
    if (n >= 1 && n <= BLOCKS.length) {
      selectedSlot = n - 1;
      updateHotbar();
    }
  });

  document.addEventListener('keyup', function(e) { keys[e.key.toLowerCase()] = false; });

  renderer && renderer.domElement.addEventListener('mousedown', function(e) {
    if (!isLocked) return;
    var target = getTargetBlock();
    if (!target.pos) return;

    if (e.button === 0) {
      removeBlock(target.pos.x, target.pos.y, target.pos.z);
    } else if (e.button === 2) {
      placeBlock(
        target.pos.x + target.face.x,
        target.pos.y + target.face.y,
        target.pos.z + target.face.z,
        selectedSlot
      );
    }
  });

  renderer && renderer.domElement.addEventListener('contextmenu', function(e) { e.preventDefault(); });

  // ============ Hotbar ============

  function buildHotbar() {
    var hotbar = document.getElementById('hotbar');
    for (var i = 0; i < BLOCKS.length; i++) {
      var slot = document.createElement('div');
      slot.className = 'slot' + (i === 0 ? ' active' : '');
      var dot = document.createElement('div');
      dot.className = 'color-dot';
      dot.style.background = '#' + BLOCKS[i].color.toString(16).padStart(6, '0');
      slot.appendChild(dot);
      slot.title = BLOCKS[i].name;
      slot.dataset.index = i;
      slot.addEventListener('click', function() {
        selectedSlot = parseInt(this.dataset.index, 10);
        updateHotbar();
      });
      hotbar.appendChild(slot);
    }
    updateBlockLabel();
  }

  function updateHotbar() {
    var slots = document.querySelectorAll('#hotbar .slot');
    for (var i = 0; i < slots.length; i++) {
      slots[i].classList.toggle('active', i === selectedSlot);
    }
    updateBlockLabel();
  }

  function updateBlockLabel() {
    document.getElementById('block-label').textContent =
      BLOCKS[selectedSlot].name + ' [' + (selectedSlot + 1) + ']';
  }

  // ============ Player Movement ============

  function collides(x, y, z) {
    var rx = Math.floor(x);
    var ry = Math.floor(y);
    var rz = Math.floor(z);
    // Check 4 corners of player hitbox (0.6 wide, 1.8 tall)
    for (var dx = -0.3; dx <= 0.3; dx += 0.6) {
      for (var dz = -0.3; dz <= 0.3; dz += 0.6) {
        var bx = Math.floor(x + dx);
        var bz = Math.floor(z + dz);
        for (var dy = 0; dy < 1.8; dy += 0.9) {
          if (getBlock(bx, Math.floor(y + dy), bz) !== 0) return true;
        }
      }
    }
    return false;
  }

  function updatePlayer(dt) {
    if (!isLocked) return;

    var forward = { x: -Math.sin(player.yaw), z: -Math.cos(player.yaw) };
    var right = { x: Math.cos(player.yaw), z: -Math.sin(player.yaw) };

    var mx = 0, mz = 0;
    if (keys['w']) { mx += forward.x; mz += forward.z; }
    if (keys['s']) { mx -= forward.x; mz -= forward.z; }
    if (keys['a']) { mx -= right.x; mz -= right.z; }
    if (keys['d']) { mx += right.x; mz += right.z; }

    var len = Math.sqrt(mx * mx + mz * mz);
    if (len > 0) { mx /= len; mz /= len; }

    var speed = player.flying ? FLY_SPEED : PLAYER_SPEED;
    player.vel.x = mx * speed;
    player.vel.z = mz * speed;

    if (player.flying) {
      player.vel.y = 0;
      if (keys[' ']) player.vel.y = speed;
      if (keys['shift']) player.vel.y = -speed;
    } else {
      player.vel.y += GRAVITY * dt;
      if (keys[' '] && player.onGround) {
        player.vel.y = JUMP_SPEED;
        player.onGround = false;
      }
    }

    // Apply X
    player.pos.x += player.vel.x * dt;
    if (collides(player.pos.x, player.pos.y, player.pos.z)) {
      player.pos.x -= player.vel.x * dt;
    }

    // Apply Y
    player.pos.y += player.vel.y * dt;
    if (collides(player.pos.x, player.pos.y, player.pos.z)) {
      if (player.vel.y < 0) {
        player.pos.y = Math.floor(player.pos.y) + 1;
        player.onGround = true;
      } else {
        player.pos.y = Math.ceil(player.pos.y) - 1.8;
      }
      player.vel.y = 0;
    } else {
      if (!player.flying) player.onGround = false;
    }

    // Apply Z
    player.pos.z += player.vel.z * dt;
    if (collides(player.pos.x, player.pos.y, player.pos.z)) {
      player.pos.z -= player.vel.z * dt;
    }

    // Camera
    camera.position.set(player.pos.x + 0.5, player.pos.y + 1.6, player.pos.z + 0.5);
    var euler = new THREE.Euler(player.pitch, player.yaw, 0, 'YXZ');
    camera.quaternion.setFromEuler(euler);

    document.getElementById('pos').textContent =
      Math.floor(player.pos.x) + ', ' + Math.floor(player.pos.y) + ', ' + Math.floor(player.pos.z);
  }

  // ============ Scene Setup ============

  function setupScene() {
    scene.background = new THREE.Color(0x87CEEB);
    scene.fog = new THREE.Fog(0x87CEEB, 30, 50);

    scene.add(new THREE.AmbientLight(0x404060, 0.6));

    var sun = new THREE.DirectionalLight(0xffeedd, 1.2);
    sun.position.set(50, 100, 30);
    scene.add(sun);

    var fill = new THREE.DirectionalLight(0x8888ff, 0.3);
    fill.position.set(-30, 20, -50);
    scene.add(fill);

    var water = new THREE.Mesh(
      new THREE.PlaneGeometry(WORLD_SIZE * 2, WORLD_SIZE * 2),
      new THREE.MeshLambertMaterial({ color: 0x2a6f8c, transparent: true, opacity: 0.6 })
    );
    water.rotation.x = -Math.PI / 2;
    water.position.set(WORLD_SIZE / 2, -1, WORLD_SIZE / 2);
    scene.add(water);
  }

  // ============ Init ============

  function init() {
    scene = new THREE.Scene();
    setupScene();

    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    document.body.appendChild(renderer.domElement);

    // Attach mouse events now that renderer exists
    renderer.domElement.addEventListener('mousedown', function(e) {
      if (!isLocked) return;
      var target = getTargetBlock();
      if (!target.pos) return;
      if (e.button === 0) {
        removeBlock(target.pos.x, target.pos.y, target.pos.z);
      } else if (e.button === 2) {
        placeBlock(
          target.pos.x + target.face.x,
          target.pos.y + target.face.y,
          target.pos.z + target.face.z,
          selectedSlot
        );
      }
    });

    renderer.domElement.addEventListener('contextmenu', function(e) { e.preventDefault(); });

    generateWorld();
    rebuildMesh();
    buildHotbar();

    var h = getHeight(0, 0);
    player.pos.y = h + 3;

    window.addEventListener('resize', function() {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    });

    animate();
  }

  // ============ Game Loop ============

  var lastTime = 0;
  var frameCount = 0;
  var fpsTime = 0;

  function animate(time) {
    requestAnimationFrame(animate);

    if (!lastTime) lastTime = time;
    var dt = Math.min((time - lastTime) / 1000, 0.05);
    lastTime = time;

    frameCount++;
    if (time - fpsTime >= 1000) {
      document.getElementById('fps').textContent = frameCount;
      frameCount = 0;
      fpsTime = time;
    }

    updatePlayer(dt);
    renderer.render(scene, camera);
  }

  init();
})();
