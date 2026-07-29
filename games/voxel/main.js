/* Voxel World - 3D block-building game using Three.js */

(function() {
  'use strict';

  if (typeof THREE === 'undefined') {
    document.getElementById('instructions').innerHTML =
      '<h1 style="color:#FF6B6B">Failed to load Three.js</h1>' +
      '<p style="color:#aaa">Check your connection and reload.</p>';
    return;
  }

  // ==================== Config ====================

  var WORLD_SIZE = 32;
  var PLAYER_WALK_SPEED = 5;
  var PLAYER_FLY_SPEED = 10;
  var GRAVITY = -22;
  var JUMP_SPEED = 8;
  var REACH = 6;
  var MOUSE_SENS = 0.002;
  var TOUCH_SENS = 0.006;

  var BLOCKS = [
    { id: 'grass',  color: 0x4a8c3f, name: 'Grass'  },
    { id: 'dirt',   color: 0x8B5A2B, name: 'Dirt'   },
    { id: 'stone',  color: 0x808080, name: 'Stone'   },
    { id: 'wood',   color: 0x6B4226, name: 'Wood'    },
    { id: 'leaves', color: 0x2d8c2d, name: 'Leaves'  },
    { id: 'sand',   color: 0xdbc9a0, name: 'Sand'    },
    { id: 'brick',  color: 0xb85c38, name: 'Brick'   },
  ];

  // ==================== State ====================

  var world = {};
  var scene, camera, renderer;
  var meshGroup = null;
  var isLocked = false;
  var isMobile = false;
  var selectedSlot = 0;
  var blockCount = 0;
  var keys = {};
  var touchMoveKeys = { fwd: false, back: false, left: false, right: false, up: false, down: false };

  var player = {
    x: WORLD_SIZE / 2, y: 0, z: WORLD_SIZE / 2,
    vx: 0, vy: 0, vz: 0,
    yaw: 0, pitch: 0,
    onGround: false, flying: true,
  };

  // Reusable vectors (zero GC per frame)
  var _rcBox = new THREE.Box3();
  var _rcHit = new THREE.Vector3();
  var _rcOrigin = new THREE.Vector3();
  var _rcLocal = new THREE.Vector3();
  var _euler = new THREE.Euler(0, 0, 0, 'YXZ');

  // ==================== Simple Noise ====================

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

  function fbm(x, y, octaves) {
    var v = 0, amp = 1, freq = 1, total = 0;
    for (var i = 0; i < octaves; i++) {
      v += amp * smoothNoise(x * freq, y * freq);
      total += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return v / total;
  }

  function getHeight(x, z) {
    return Math.floor(fbm(x / 20, z / 20, 4) * 8 + 10);
  }

  // ==================== World Data ====================

  function key(x, y, z) { return x + ',' + y + ',' + z; }

  function setBlock(x, y, z, type) {
    if (y < 0 || y > 64) return;
    for (var i = 0; i < BLOCKS.length; i++) {
      if (BLOCKS[i].id === type) { world[key(x, y, z)] = i + 1; return; }
    }
  }

  function getBlock(x, y, z) { return world[key(x, y, z)] || 0; }

  // ==================== World Generation ====================

  function generateWorld() {
    var cx = WORLD_SIZE / 2, cz = WORLD_SIZE / 2;

    for (var x = 0; x < WORLD_SIZE; x++) {
      for (var z = 0; z < WORLD_SIZE; z++) {
        var h = getHeight(x - cx, z - cz);
        var beach = h <= 1;

        for (var y = 0; y <= h; y++) {
          if (y === h) setBlock(x, y, z, beach ? 'sand' : 'grass');
          else if (y > h - 3) setBlock(x, y, z, 'dirt');
          else setBlock(x, y, z, 'stone');
        }

        // Trees
        if (!beach && h >= 3 && Math.random() < 0.03) {
          var trunk = 3 + Math.floor(Math.random() * 2);
          for (var ty = h + 1; ty <= h + trunk; ty++) setBlock(x, ty, z, 'wood');
          var ls = h + trunk - 1;
          for (var lx = -2; lx <= 2; lx++)
            for (var lz = -2; lz <= 2; lz++)
              for (var ly = 0; ly <= 2; ly++)
                if (Math.abs(lx) + Math.abs(lz) + Math.abs(ly - 1) <= 3)
                  setBlock(x + lx, ls + ly, z + lz, 'leaves');
        }
      }
    }
  }

  // Clear a 3x3 area around spawn so player doesn't spawn inside blocks
  function clearSpawnArea(cx, cz) {
    for (var dx = -2; dx <= 2; dx++)
      for (var dz = -2; dz <= 2; dz++)
        for (var dy = 0; dy <= 5; dy++)
          delete world[key(Math.floor(cx + dx), dy, Math.floor(cz + dz))];
  }

  // ==================== Face Culling ====================

  function hasExposedFace(x, y, z) {
    return getBlock(x + 1, y, z) === 0 || getBlock(x - 1, y, z) === 0 ||
           getBlock(x, y + 1, z) === 0 || getBlock(x, y - 1, z) === 0 ||
           getBlock(x, y, z + 1) === 0 || getBlock(x, y, z - 1) === 0;
  }

  // ==================== Mesh Building ====================

  function mergeBoxes(positions) {
    var boxGeo = new THREE.BoxGeometry(0.96, 0.96, 0.96);
    var pAttr = boxGeo.getAttribute('position');
    var uAttr = boxGeo.getAttribute('uv');
    var nAttr = boxGeo.getAttribute('normal');
    var vc = pAttr.count;
    var total = positions.length * vc;

    var pa = new Float32Array(total * 3);
    var ua = new Float32Array(total * 2);
    var na = new Float32Array(total * 3);
    var ia = [];

    for (var i = 0; i < positions.length; i++) {
      var b = positions[i];
      var off = i * vc * 3, uoff = i * vc * 2, ioff = i * vc;
      for (var j = 0; j < vc; j++) {
        pa[off + j*3]     = pAttr.getX(j) + b.x;
        pa[off + j*3 + 1] = pAttr.getY(j) + b.y;
        pa[off + j*3 + 2] = pAttr.getZ(j) + b.z;
        ua[uoff + j*2]     = uAttr.getX(j);
        ua[uoff + j*2 + 1] = uAttr.getY(j);
        na[off + j*3]     = nAttr.getX(j);
        na[off + j*3 + 1] = nAttr.getY(j);
        na[off + j*3 + 2] = nAttr.getZ(j);
      }
      var idx = boxGeo.getIndex();
      for (var k = 0; k < idx.count; k++) ia.push(idx.getX(k) + ioff);
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
    if (meshGroup) { scene.remove(meshGroup); meshGroup = null; }

    meshGroup = new THREE.Group();
    var byType = {};
    for (var k in world) {
      var id = world[k];
      if (!byType[id]) byType[id] = [];
      var p = k.split(',');
      byType[id].push({ x: parseInt(p[0]), y: parseInt(p[1]), z: parseInt(p[2]) });
    }

    for (var typeId in byType) {
      var list = byType[typeId];
      var visible = [];
      for (var i = 0; i < list.length; i++) {
        var b = list[i];
        if (hasExposedFace(b.x, b.y, b.z)) visible.push(b);
      }
      if (!visible.length) continue;
      var color = BLOCKS[parseInt(typeId) - 1].color;
      var mesh = new THREE.Mesh(mergeBoxes(visible), new THREE.MeshLambertMaterial({ color: color }));
      meshGroup.add(mesh);
    }
    scene.add(meshGroup);
  }

  // ==================== Block Operations ====================

  function removeBlock(x, y, z) {
    delete world[key(x, y, z)];
    rebuildMesh();
    blockCount = Math.max(0, blockCount - 1);
    updateInfo();
  }

  function placeBlock(x, y, z, typeId) {
    if (getBlock(x, y, z) !== 0) return;
    var px = Math.floor(player.x), py = Math.floor(player.y), pz = Math.floor(player.z);
    if (x === px && Math.abs(y - py) <= 1 && z === pz) return;
    setBlock(x, y, z, BLOCKS[typeId].id);
    rebuildMesh();
    blockCount++;
    updateInfo();
  }

  // ==================== Raycasting ====================

  var raycaster = new THREE.Raycaster();
  raycaster.far = REACH;

  function getTargetBlock() {
    raycaster.setFromCamera({ x: 0, y: 0 }, camera);
    _rcOrigin.copy(raycaster.ray.origin);

    var closestDist = Infinity, closestPos = null, closestFace = null;

    for (var k in world) {
      var p = k.split(',');
      var bx = parseInt(p[0]), by = parseInt(p[1]), bz = parseInt(p[2]);
      _rcBox.min.set(bx, by, bz);
      _rcBox.max.set(bx + 1, by + 1, bz + 1);

      if (!raycaster.ray.intersectsBox(_rcBox, _rcHit)) continue;
      var dist = _rcOrigin.distanceTo(_rcHit);
      if (dist >= closestDist) continue;

      closestDist = dist;
      closestPos = { x: bx, y: by, z: bz };
      _rcLocal.copy(_rcHit).sub(new THREE.Vector3(bx + 0.5, by + 0.5, bz + 0.5));
      var ax = Math.abs(_rcLocal.x), ay = Math.abs(_rcLocal.y), az = Math.abs(_rcLocal.z);

      if (ax >= ay && ax >= az) closestFace = { x: _rcLocal.x > 0 ? 1 : -1, y: 0, z: 0 };
      else if (ay >= ax && ay >= az) closestFace = { x: 0, y: _rcLocal.y > 0 ? 1 : -1, z: 0 };
      else closestFace = { x: 0, y: 0, z: _rcLocal.z > 0 ? 1 : -1 };
    }
    return { pos: closestPos, face: closestFace };
  }

  // ==================== Collision Detection ====================

  function collides(x, y, z) {
    for (var dx = -0.3; dx <= 0.3; dx += 0.6) {
      for (var dz = -0.3; dz <= 0.3; dz += 0.6) {
        var bx = Math.floor(x + dx), bz = Math.floor(z + dz);
        for (var dy = 0; dy <= 1.8; dy += 0.9) {
          if (getBlock(bx, Math.floor(y + dy), bz) !== 0) return true;
        }
      }
    }
    return false;
  }

  // ==================== Physics / Movement ====================

  function updatePlayer(dt) {
    if (!isLocked && !isMobile) return;

    // --- Direction vectors ---
    var sinY = Math.sin(player.yaw), cosY = Math.cos(player.yaw);
    var fwd = { x: -sinY, z: -cosY };
    var right = { x: cosY, z: -sinY };

    // --- Gather input ---
    var mx = 0, mz = 0;
    function addKey(k, dx, dz) { if (k) { mx += dx; mz += dz; } }
    addKey(keys['w'] || touchMoveKeys.fwd, fwd.x, fwd.z);
    addKey(keys['s'] || touchMoveKeys.back, -fwd.x, -fwd.z);
    addKey(keys['a'] || touchMoveKeys.left, -right.x, -right.z);
    addKey(keys['d'] || touchMoveKeys.right, right.x, right.z);

    var len = Math.sqrt(mx * mx + mz * mz);
    if (len > 0) { mx /= len; mz /= len; }

    var speed = player.flying ? PLAYER_FLY_SPEED : PLAYER_WALK_SPEED;

    if (player.flying) {
      player.vx = mx * speed;
      player.vz = mz * speed;
      player.vy = 0;
      if (keys[' '] || touchMoveKeys.up)   player.vy = speed;
      if (keys['shift'] || touchMoveKeys.down) player.vy = -speed;
    } else {
      player.vx = mx * speed;
      player.vz = mz * speed;
      player.vy += GRAVITY * dt;
      if ((keys[' '] || touchMoveKeys.up) && player.onGround) {
        player.vy = JUMP_SPEED;
        player.onGround = false;
      }
    }

    // --- Integrate X ---
    player.x += player.vx * dt;
    if (collides(player.x, player.y, player.z)) player.x -= player.vx * dt;

    // --- Integrate Y ---
    player.y += player.vy * dt;
    if (collides(player.x, player.y, player.z)) {
      if (player.vy < 0) {
        player.y = Math.floor(player.y) + 1;
        player.onGround = true;
      } else {
        player.y = Math.ceil(player.y) - 1.8;
      }
      player.vy = 0;
    } else if (!player.flying) {
      // Check if standing on ground
      var onGround = false;
      for (var dx = -0.3; dx <= 0.3 && !onGround; dx += 0.6)
        for (var dz = -0.3; dz <= 0.3 && !onGround; dz += 0.6)
          if (getBlock(Math.floor(player.x + dx), Math.floor(player.y - 0.05), Math.floor(player.z + dz)) !== 0)
            onGround = true;
      player.onGround = onGround;
    }

    // --- Integrate Z ---
    player.z += player.vz * dt;
    if (collides(player.x, player.y, player.z)) player.z -= player.vz * dt;

    // --- Clamp to world ---
    player.x = Math.max(0.3, Math.min(WORLD_SIZE - 0.3, player.x));
    player.z = Math.max(0.3, Math.min(WORLD_SIZE - 0.3, player.z));

    // --- Camera ---
    camera.position.set(player.x + 0.5, player.y + 1.6, player.z + 0.5);
    _euler.set(player.pitch, player.yaw, 0);
    camera.quaternion.setFromEuler(_euler);

    updateInfo();
  }

  // ==================== Info UI ====================

  function updateInfo() {
    document.getElementById('pos').textContent =
      Math.floor(player.x) + ', ' + Math.floor(player.y) + ', ' + Math.floor(player.z);
  }

  // ==================== Scene Setup ====================

  function setupScene() {
    scene = new THREE.Scene();
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
      new THREE.PlaneGeometry(WORLD_SIZE * 3, WORLD_SIZE * 3),
      new THREE.MeshLambertMaterial({ color: 0x2a6f8c, transparent: true, opacity: 0.5 })
    );
    water.rotation.x = -Math.PI / 2;
    water.position.set(WORLD_SIZE / 2, -0.5, WORLD_SIZE / 2);
    scene.add(water);
  }

  // ==================== Input — Desktop ====================

  function setupDesktopInput() {
    document.getElementById('blocker').addEventListener('click', function() {
      renderer.domElement.requestPointerLock();
    });

    document.addEventListener('pointerlockchange', function() {
      isLocked = document.pointerLockElement === renderer.domElement;
      document.getElementById('blocker').classList.toggle('hidden', isLocked);
    });

    document.addEventListener('mousemove', function(e) {
      if (!isLocked) return;
      player.yaw   -= e.movementX * MOUSE_SENS;
      player.pitch -= e.movementY * MOUSE_SENS;
      player.pitch = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, player.pitch));
    });

    document.addEventListener('keydown', function(e) {
      keys[e.key.toLowerCase()] = true;
      if (e.key === 'Escape' && isLocked) document.exitPointerLock();
      var n = parseInt(e.key, 10);
      if (n >= 1 && n <= BLOCKS.length) { selectedSlot = n - 1; updateHotbar(); }
    });

    document.addEventListener('keyup', function(e) { keys[e.key.toLowerCase()] = false; });

    renderer.domElement.addEventListener('mousedown', function(e) {
      if (!isLocked) return;
      e.preventDefault();
      interact(e.button === 2);
    });
    renderer.domElement.addEventListener('contextmenu', function(e) { e.preventDefault(); });
  }

  // ==================== Input — Mobile ====================

  function setupMobileInput() {
    isMobile = true;
    document.getElementById('desktopKeys').style.display = 'none';
    document.getElementById('mobileKeys').style.display = '';
    document.getElementById('touchControls').style.display = '';
    document.getElementById('startHint').textContent = 'Tap to start';

    // Blocker: just hide it on tap (no pointer lock on mobile)
    document.getElementById('blocker').addEventListener('click', function() {
      document.getElementById('blocker').classList.add('hidden');
    });

    // Touch drag to look (on the whole screen)
    var lastTouch = null;
    document.addEventListener('touchstart', function(e) {
      if (e.touches.length === 1) {
        lastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }
    }, { passive: true });

    document.addEventListener('touchmove', function(e) {
      if (!lastTouch || e.touches.length !== 1) return;
      var dx = e.touches[0].clientX - lastTouch.x;
      var dy = e.touches[0].clientY - lastTouch.y;
      player.yaw   -= dx * TOUCH_SENS;
      player.pitch -= dy * TOUCH_SENS;
      player.pitch = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, player.pitch));
      lastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      e.preventDefault();
    }, { passive: false });

    document.addEventListener('touchend', function(e) {
      if (e.touches.length === 0) lastTouch = null;
    }, { passive: true });

    // Tap to remove block (single tap) / place block (long press then tap)
    var tapTimeout = null;
    var isLongPress = false;
    renderer.domElement.addEventListener('touchstart', function(e) {
      if (e.touches.length > 1) return;
      isLongPress = false;
      tapTimeout = setTimeout(function() { isLongPress = true; }, 400);
    }, { passive: true });

    renderer.domElement.addEventListener('touchend', function(e) {
      clearTimeout(tapTimeout);
      if (!document.getElementById('blocker').classList.contains('hidden')) return;
      var target = getTargetBlock();
      if (!target.pos) return;
      if (isLongPress) {
        // Long press → place
        placeBlock(target.pos.x + target.face.x, target.pos.y + target.face.y, target.pos.z + target.face.z, selectedSlot);
      } else {
        // Tap → remove
        removeBlock(target.pos.x, target.pos.y, target.pos.z);
      }
    }, { passive: true });

    // Virtual buttons for movement
    function setupBtn(id, key) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('touchstart', function(e) { e.preventDefault(); touchMoveKeys[key] = true; }, { passive: false });
      el.addEventListener('touchend',   function(e) { e.preventDefault(); touchMoveKeys[key] = false; }, { passive: false });
      el.addEventListener('touchcancel', function(e) { touchMoveKeys[key] = false; }, { passive: true });
      // Mouse fallback for debugging
      el.addEventListener('mousedown', function() { touchMoveKeys[key] = true; });
      el.addEventListener('mouseup',   function() { touchMoveKeys[key] = false; });
      el.addEventListener('mouseleave', function() { touchMoveKeys[key] = false; });
    }

    setupBtn('btnFwd',  'fwd');
    setupBtn('btnBack', 'back');
    setupBtn('btnLeft', 'left');
    setupBtn('btnRight','right');
    setupBtn('btnUp',   'up');
    setupBtn('btnDown', 'down');

    // Touch hotbar
    document.querySelectorAll('#hotbar .slot').forEach(function(slot) {
      slot.addEventListener('touchend', function(e) {
        e.stopPropagation();
        selectedSlot = parseInt(this.dataset.index, 10);
        updateHotbar();
      });
    });
  }

  // ==================== Interaction (Desktop) ====================

  function interact(isRightClick) {
    var target = getTargetBlock();
    if (!target.pos) return;
    if (!isRightClick) {
      removeBlock(target.pos.x, target.pos.y, target.pos.z);
    } else {
      placeBlock(target.pos.x + target.face.x, target.pos.y + target.face.y, target.pos.z + target.face.z, selectedSlot);
    }
  }

  // ==================== Hotbar ====================

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
    for (var i = 0; i < slots.length; i++) slots[i].classList.toggle('active', i === selectedSlot);
    updateBlockLabel();
  }

  function updateBlockLabel() {
    document.getElementById('block-label').textContent =
      BLOCKS[selectedSlot].name + ' [' + (selectedSlot + 1) + ']';
  }

  // ==================== Init ====================

  function init() {
    scene = new THREE.Scene();
    setupScene();

    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    document.body.insertBefore(renderer.domElement, document.getElementById('crosshair'));

    // Detect mobile
    var isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    if (isTouchDevice) {
      setupMobileInput();
    } else {
      setupDesktopInput();
    }

    // Generate world
    generateWorld();

    // Find safe spawn: clear area, find highest block at center
    var spawnX = WORLD_SIZE / 2, spawnZ = WORLD_SIZE / 2;
    clearSpawnArea(spawnX, spawnZ);
    rebuildMesh();

    var cx = WORLD_SIZE / 2, cz = WORLD_SIZE / 2;
    var groundY = getHeight(0, 0);
    // Make sure there's no block at spawn
    for (var y = groundY + 5; y >= 0; y--) {
      var blocked = false;
      for (var dx = -1; dx <= 1 && !blocked; dx++)
        for (var dz = -1; dz <= 1 && !blocked; dz++)
          if (getBlock(Math.floor(spawnX + dx), y, Math.floor(spawnZ + dz)) !== 0) blocked = true;
      if (!blocked) { groundY = y; break; }
    }

    player.x = spawnX;
    player.z = spawnZ;
    player.y = groundY;
    player.yaw = 0;
    player.pitch = 0;
    player.flying = true;
    player.vx = 0;
    player.vy = 0;
    player.vz = 0;
    player.onGround = false;

    buildHotbar();
    updateInfo();

    window.addEventListener('resize', function() {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    });

    animate();
  }

  // ==================== Game Loop ====================

  var lastTime = 0;
  var frameCount = 0;
  var fpsTimer = 0;

  function animate(time) {
    requestAnimationFrame(animate);
    if (!lastTime) lastTime = time;
    var dt = Math.min((time - lastTime) / 1000, 0.05);
    lastTime = time;

    frameCount++;
    if (time - fpsTimer >= 1000) {
      document.getElementById('fps').textContent = frameCount;
      frameCount = 0;
      fpsTimer = time;
    }

    updatePlayer(dt);
    renderer.render(scene, camera);
  }

  // Handle Three.js load race
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
