/* Voxel World - A 3D block-building game using Three.js */

(function() {
  'use strict';

  // ============ Config ============
  var WORLD_SIZE = 32;
  var BLOCK_SIZE = 1;
  var GRAVITY = -20;
  var PLAYER_SPEED = 5;
  var JUMP_SPEED = 8;
  var REACH = 6;
  var SENSITIVITY = 0.002;
  var CHUNK_SIZE = 16;

  // ============ Block Types ============
  var BLOCKS = {
    grass:  { color: 0x4a8c3f, name: 'Grass' },
    dirt:   { color: 0x8B5A2B, name: 'Dirt' },
    stone:  { color: 0x808080, name: 'Stone' },
    wood:   { color: 0x6B4226, name: 'Wood' },
    leaves: { color: 0x2d8c2d, name: 'Leaves' },
    sand:   { color: 0xdbc9a0, name: 'Sand' },
    brick:  { color: 0xb85c38, name: 'Brick' },
    plank:  { color: 0xc4a35a, name: 'Plank' },
  };
  var BLOCK_IDS = Object.keys(BLOCKS);
  var BLOCK_COLORS = BLOCK_IDS.map(function(id) { return BLOCKS[id].color; });

  // ============ World Data ============
  var world = {}; // key "x,y,z" -> block type index (1-based)
  var meshGroup = null;
  var geometry = null;
  var scene, camera, renderer;

  // ============ Player State ============
  var player = {
    position: { x: WORLD_SIZE/2, y: 20, z: WORLD_SIZE/2 },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    onGround: false,
    flying: true,
  };

  var keys = {};
  var isLocked = false;
  var selectedSlot = 0;
  var blockCount = 0;
  var frameCount = 0;
  var lastFpsTime = 0;
  var fps = 60;

  // ============ Simple Noise ============
  // A simple value noise implementation
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
  function generateWorld() {
    var cx = WORLD_SIZE / 2;
    var cz = WORLD_SIZE / 2;

    for (var x = 0; x < WORLD_SIZE; x++) {
      for (var z = 0; z < WORLD_SIZE; z++) {
        var height = getHeight(x - cx, z - cz);
        var isBeach = height <= 1;

        for (var y = 0; y <= height; y++) {
          var type;
          if (y === height) {
            type = isBeach ? 'sand' : 'grass';
          } else if (y > height - 3) {
            type = 'dirt';
          } else {
            type = 'stone';
          }
          setBlock(x, y, z, type);
        }

        // Place trees on grass areas
        if (!isBeach && height >= 3 && Math.random() < 0.03) {
          var trunkHeight = 3 + Math.floor(Math.random() * 2);
          for (var ty = height + 1; ty <= height + trunkHeight; ty++) {
            setBlock(x, ty, z, 'wood');
          }
          var leafStart = height + trunkHeight - 1;
          for (var lx = -2; lx <= 2; lx++) {
            for (var lz = -2; lz <= 2; lz++) {
              for (var ly = 0; ly <= 2; ly++) {
                var dist = Math.abs(lx) + Math.abs(lz) + Math.abs(ly - 1);
                if (dist <= 3) {
                  setBlock(x + lx, leafStart + ly, z + lz, 'leaves');
                }
              }
            }
          }
        }
      }
    }
  }

  // ============ Block Operations ============
  function blockKey(x, y, z) {
    return x + ',' + y + ',' + z;
  }

  function setBlock(x, y, z, type) {
    if (y < 0 || y > 64) return;
    var id = BLOCK_IDS.indexOf(type);
    if (id === -1) return;
    world[blockKey(x, y, z)] = id + 1;
  }

  function getBlock(x, y, z) {
    return world[blockKey(x, y, z)] || 0;
  }

  function removeBlock(x, y, z) {
    delete world[blockKey(x, y, z)];
    rebuildMesh();
  }

  function placeBlock(x, y, z, type) {
    if (getBlock(x, y, z) !== 0) return;
    // Don't place inside player
    var px = Math.floor(player.position.x);
    var py = Math.floor(player.position.y);
    var pz = Math.floor(player.position.z);
    if (x === px && (y === py || y === py + 1) && z === pz) return;
    if (x === px && y === py && z === pz) return;

    setBlock(x, y, z, type);
    rebuildMesh();
    blockCount++;
    updateInfo();
  }

  // ============ Mesh Building ============
  function rebuildMesh() {
    if (meshGroup) {
      scene.remove(meshGroup);
      meshGroup = null;
    }
    if (geometry) { geometry.dispose(); geometry = null; }

    meshGroup = new THREE.Group();

    // Group blocks by type for instancing
    var blocksByType = {};
    for (var key in world) {
      var id = world[key];
      if (!blocksByType[id]) blocksByType[id] = [];
      var parts = key.split(',');
      blocksByType[id].push({
        x: parseInt(parts[0]),
        y: parseInt(parts[1]),
        z: parseInt(parts[2])
      });
    }

    for (var typeId in blocksByType) {
      var positions = blocksByType[typeId];
      var color = BLOCK_COLORS[parseInt(typeId) - 1];
      var count = positions.length;

      // Only render visible blocks (with at least one exposed face)
      var visible = [];
      for (var i = 0; i < positions.length; i++) {
        var p = positions[i];
        if (hasExposedFace(p.x, p.y, p.z)) {
          visible.push(p);
        }
      }

      if (visible.length === 0) continue;

      // Use merged geometry for each type
      var geo = new THREE.BoxGeometry(0.98, 0.98, 0.98);
      var material = new THREE.MeshLambertMaterial({ color: color });
      var groupGeo = new THREE.InstancedBufferGeometry();

      // For smaller batches, use merged geometry
      var merged = mergeBoxes(visible, geo);
      var mesh = new THREE.Mesh(merged, material);
      mesh.position.set(0, 0, 0);
      meshGroup.add(mesh);

      geo.dispose();
    }

    scene.add(meshGroup);
  }

  function hasExposedFace(x, y, z) {
    return getBlock(x + 1, y, z) === 0 ||
           getBlock(x - 1, y, z) === 0 ||
           getBlock(x, y + 1, z) === 0 ||
           getBlock(x, y - 1, z) === 0 ||
           getBlock(x, y, z + 1) === 0 ||
           getBlock(x, y, z - 1) === 0;
  }

  function mergeBoxes(positions, boxGeo) {
    var posAttr = boxGeo.getAttribute('position');
    var uvAttr = boxGeo.getAttribute('uv');
    var normAttr = boxGeo.getAttribute('normal');
    var vertCount = posAttr.count;
    var totalVerts = positions.length * vertCount;

    var positionsArr = new Float32Array(totalVerts * 3);
    var uvsArr = new Float32Array(totalVerts * 2);
    var normalsArr = new Float32Array(totalVerts * 3);
    var indicesArr = [];

    for (var i = 0; i < positions.length; i++) {
      var p = positions[i];
      var offset = i * vertCount * 3;
      var uvOffset = i * vertCount * 2;
      var idxOffset = i * vertCount;

      // Copy positions with offset
      for (var j = 0; j < vertCount; j++) {
        positionsArr[offset + j * 3] = posAttr.getX(j) + p.x;
        positionsArr[offset + j * 3 + 1] = posAttr.getY(j) + p.y;
        positionsArr[offset + j * 3 + 2] = posAttr.getZ(j) + p.z;
        uvsArr[uvOffset + j * 2] = uvAttr.getX(j);
        uvsArr[uvOffset + j * 2 + 1] = uvAttr.getY(j);
        normalsArr[offset + j * 3] = normAttr.getX(j);
        normalsArr[offset + j * 3 + 1] = normAttr.getY(j);
        normalsArr[offset + j * 3 + 2] = normAttr.getZ(j);
      }

      // Indices
      var boxIdx = boxGeo.getIndex();
      if (boxIdx) {
        for (var k = 0; k < boxIdx.count; k++) {
          indicesArr.push(boxIdx.getX(k) + idxOffset);
        }
      }
    }

    var merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(positionsArr, 3));
    merged.setAttribute('uv', new THREE.BufferAttribute(uvsArr, 2));
    merged.setAttribute('normal', new THREE.BufferAttribute(normalsArr, 3));
    merged.setIndex(indicesArr);
    merged.computeVertexNormals();
    return merged;
  }

  // ============ Raycaster ============
  var raycaster = new THREE.Raycaster();
  raycaster.far = REACH;

  function getTargetBlock() {
    raycaster.setFromCamera({ x: 0, y: 0 }, camera);

    // Check against all block positions
    var closestDist = Infinity;
    var closestPos = null;
    var closestFace = null;

    var faceNormals = [
      { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 },
      { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 },
    ];

    for (var key in world) {
      var parts = key.split(',');
      var bx = parseInt(parts[0]);
      var by = parseInt(parts[1]);
      var bz = parseInt(parts[2]);

      var center = new THREE.Vector3(bx + 0.5, by + 0.5, bz + 0.5);
      var half = new THREE.Vector3(0.5, 0.5, 0.5);
      var box = new THREE.Box3(
        new THREE.Vector3(bx, by, bz),
        new THREE.Vector3(bx + 1, by + 1, bz + 1)
      );

      var hit = raycaster.ray.intersectsBox(box, new THREE.Vector3());
      if (hit) {
        // Find which face was hit
        var entryPoint = raycaster.ray.origin.clone().add(
          raycaster.ray.direction.clone().multiplyScalar(hit)
        );
        var dist = raycaster.ray.origin.distanceTo(entryPoint);
        if (dist < closestDist) {
          closestDist = dist;
          closestPos = { x: bx, y: by, z: bz };

          // Determine face
          var local = {
            x: entryPoint.x - bx - 0.5,
            y: entryPoint.y - by - 0.5,
            z: entryPoint.z - bz - 0.5,
          };
          var absX = Math.abs(local.x);
          var absY = Math.abs(local.y);
          var absZ = Math.abs(local.z);
          if (absX >= absY && absX >= absZ) {
            closestFace = { x: local.x > 0 ? 1 : -1, y: 0, z: 0 };
          } else if (absY >= absX && absY >= absZ) {
            closestFace = { x: 0, y: local.y > 0 ? 1 : -1, z: 0 };
          } else {
            closestFace = { x: 0, y: 0, z: local.z > 0 ? 1 : -1 };
          }
        }
      }
    }

    return { pos: closestPos, face: closestFace, dist: closestDist };
  }

  // ============ Input ============
  var blocker = document.getElementById('blocker');
  blocker.addEventListener('click', function() {
    renderer.domElement.requestPointerLock();
  });

  document.addEventListener('pointerlockchange', function() {
    isLocked = document.pointerLockElement === renderer.domElement;
    blocker.classList.toggle('hidden', isLocked);
  });

  document.addEventListener('mousemove', function(e) {
    if (!isLocked) return;
    player.yaw -= e.movementX * SENSITIVITY;
    player.pitch -= e.movementY * SENSITIVITY;
    player.pitch = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, player.pitch));
  });

  document.addEventListener('keydown', function(e) {
    keys[e.key.toLowerCase()] = true;
    if (e.key === 'Escape' && isLocked) {
      document.exitPointerLock();
    }
    // Block selection
    var num = parseInt(e.key);
    if (num >= 1 && num <= 7) {
      selectedSlot = num - 1;
      updateHotbar();
    }
  });

  document.addEventListener('keyup', function(e) {
    keys[e.key.toLowerCase()] = false;
  });

  renderer.domElement.addEventListener('mousedown', function(e) {
    if (!isLocked) return;
    var target = getTargetBlock();
    if (!target.pos) return;

    if (e.button === 0) {
      // Left click - remove block
      removeBlock(target.pos.x, target.pos.y, target.pos.z);
      blockCount = Math.max(0, blockCount - 1);
      updateInfo();
    } else if (e.button === 2) {
      // Right click - place block adjacent to face
      placeBlock(
        target.pos.x + target.face.x,
        target.pos.y + target.face.y,
        target.pos.z + target.face.z,
        BLOCK_IDS[selectedSlot]
      );
    }
  });

  renderer.domElement.addEventListener('contextmenu', function(e) {
    e.preventDefault();
  });

  // Touch controls for mobile
  var touchStart = null;
  renderer.domElement.addEventListener('touchstart', function(e) {
    if (e.touches.length === 1) {
      touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
  });

  renderer.domElement.addEventListener('touchmove', function(e) {
    if (touchStart && e.touches.length === 1) {
      var dx = e.touches[0].clientX - touchStart.x;
      var dy = e.touches[0].clientY - touchStart.y;
      player.yaw -= dx * 0.005;
      player.pitch -= dy * 0.005;
      player.pitch = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, player.pitch));
      touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
  });

  // ============ Hotbar ============
  function buildHotbar() {
    var hotbar = document.getElementById('hotbar');
    hotbar.innerHTML = '';
    for (var i = 0; i < BLOCK_IDS.length; i++) {
      var slot = document.createElement('div');
      slot.className = 'slot';
      if (i === selectedSlot) slot.classList.add('active');
      var dot = document.createElement('div');
      dot.className = 'color-dot';
      dot.style.background = '#' + BLOCK_COLORS[i].toString(16).padStart(6, '0');
      slot.appendChild(dot);
      slot.title = BLOCK_IDS[i];
      slot.dataset.index = i;
      slot.addEventListener('click', function() {
        selectedSlot = parseInt(this.dataset.index);
        updateHotbar();
      });
      hotbar.appendChild(slot);
    }
    updateBlockLabel();
  }

  function updateHotbar() {
    var slots = document.querySelectorAll('#hotbar .slot');
    slots.forEach(function(s, i) {
      s.classList.toggle('active', i === selectedSlot);
    });
    updateBlockLabel();
  }

  function updateBlockLabel() {
    var label = document.getElementById('block-label');
    var name = BLOCKS[BLOCK_IDS[selectedSlot]].name;
    var num = selectedSlot + 1;
    label.textContent = name + ' [' + num + ']';
  }

  function updateInfo() {
    document.getElementById('blocks').textContent = blockCount;
  }

  // ============ Player Movement ============
  function updatePlayer(dt) {
    if (!isLocked) return;

    // Forward direction
    var forward = { x: -Math.sin(player.yaw), z: -Math.cos(player.yaw) };
    var right = { x: Math.cos(player.yaw), z: -Math.sin(player.yaw) };

    var moveX = 0, moveZ = 0;
    if (keys['w']) { moveX += forward.x; moveZ += forward.z; }
    if (keys['s']) { moveX -= forward.x; moveZ -= forward.z; }
    if (keys['a']) { moveX -= right.x; moveZ -= right.z; }
    if (keys['d']) { moveX += right.x; moveZ += right.z; }

    // Normalize
    var len = Math.sqrt(moveX * moveX + moveZ * moveZ);
    if (len > 0) {
      moveX /= len;
      moveZ /= len;
    }

    var speed = player.flying ? PLAYER_SPEED * 2 : PLAYER_SPEED;
    player.velocity.x = moveX * speed;
    player.velocity.z = moveZ * speed;

    if (player.flying) {
      player.velocity.y = 0;
      if (keys[' ']) player.velocity.y = speed;
      if (keys['shift']) player.velocity.y = -speed;
    } else {
      player.velocity.y += GRAVITY * dt;

      if (keys[' '] && player.onGround) {
        player.velocity.y = JUMP_SPEED;
        player.onGround = false;
      }
      if (keys['shift'] && player.onGround) {
        player.flying = true;
      }
    }

    // Double-tap space to toggle fly
    // Simple: Shift in air toggles fly

    // Apply velocity
    player.position.x += player.velocity.x * dt;
    player.position.z += player.velocity.z * dt;
    player.position.y += player.velocity.y * dt;

    // Simple collision with ground
    var gx = Math.floor(player.position.x);
    var gz = Math.floor(player.position.z);
    var feetBlock = getBlock(gx, Math.floor(player.position.y), gz);
    var headBlock = getBlock(gx, Math.floor(player.position.y + 1.8), gz);

    if (!player.flying) {
      // Ground collision
      var belowBlock = getBlock(gx, Math.floor(player.position.y - 0.1), gz);
      if (belowBlock !== 0) {
        player.position.y = Math.floor(player.position.y) + 1;
        player.velocity.y = 0;
        player.onGround = true;
      } else {
        player.onGround = false;
      }

      // Wall collision - simple
      var testY = Math.floor(player.position.y);
      if (getBlock(gx, testY, gz) !== 0) {
        // Push out
        var centerX = gx + 0.5;
        var centerZ = gz + 0.5;
        var dx = player.position.x - centerX;
        var dz = player.position.z - centerZ;
        if (Math.abs(dx) > 0.3) {
          player.position.x = centerX + (dx > 0 ? 0.5 : -0.5);
        }
        if (Math.abs(dz) > 0.3) {
          player.position.z = centerZ + (dz > 0 ? 0.5 : -0.5);
        }
      }
    } else {
      player.onGround = false;
    }

    // Update camera
    camera.position.set(
      player.position.x + 0.5,
      player.position.y + 1.6,
      player.position.z + 0.5
    );

    var euler = new THREE.Euler(player.pitch, player.yaw, 0, 'YXZ');
    camera.quaternion.setFromEuler(euler);

    // Update info
    var pos = document.getElementById('pos');
    pos.textContent = Math.floor(player.position.x) + ', ' +
      Math.floor(player.position.y) + ', ' + Math.floor(player.position.z);
  }

  // ============ Fog and Sky ============
  function setupSky() {
    scene.background = new THREE.Color(0x87CEEB);
    scene.fog = new THREE.Fog(0x87CEEB, 30, 50);
  }

  // ============ Lighting ============
  function setupLights() {
    var ambient = new THREE.AmbientLight(0x404060, 0.6);
    scene.add(ambient);

    var sun = new THREE.DirectionalLight(0xffeedd, 1.2);
    sun.position.set(50, 100, 30);
    sun.castShadow = false;
    scene.add(sun);

    var fill = new THREE.DirectionalLight(0x8888ff, 0.3);
    fill.position.set(-30, 20, -50);
    scene.add(fill);
  }

  // ============ Ground plane (for ocean) ============
  function setupWater() {
    var waterGeo = new THREE.PlaneGeometry(WORLD_SIZE * 2, WORLD_SIZE * 2);
    var waterMat = new THREE.MeshLambertMaterial({
      color: 0x2a6f8c,
      transparent: true,
      opacity: 0.6,
    });
    var water = new THREE.Mesh(waterGeo, waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.set(WORLD_SIZE / 2, -1, WORLD_SIZE / 2);
    scene.add(water);
  }

  // ============ Init ============
  function init() {
    scene = new THREE.Scene();
    setupSky();
    setupLights();

    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = false;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    document.body.appendChild(renderer.domElement);

    // Generate world
    generateWorld();
    rebuildMesh();
    setupWater();
    buildHotbar();
    updateInfo();

    // Position player
    player.position.x = WORLD_SIZE / 2;
    player.position.z = WORLD_SIZE / 2;
    player.position.y = getHeight(0, 0) + 3;
    player.yaw = 0;
    player.pitch = 0;

    // Resize
    window.addEventListener('resize', function() {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    });

    // Start loop
    lastFpsTime = performance.now();
    animate();
  }

  // ============ Game Loop ============
  var lastTime = 0;

  function animate(time) {
    requestAnimationFrame(animate);

    if (!lastTime) lastTime = time;
    var dt = Math.min((time - lastTime) / 1000, 0.05);
    lastTime = time;

    // FPS counter
    frameCount++;
    if (time - lastFpsTime >= 1000) {
      fps = frameCount;
      document.getElementById('fps').textContent = fps;
      frameCount = 0;
      lastFpsTime = time;
    }

    updatePlayer(dt);

    renderer.render(scene, camera);
  }

  // Start
  init();
})();
