(function () {
  'use strict';

  var SIZE = 4;
  var TARGET = 2048;
  var GAP = 8;
  var SAVE_KEY = 'd2048_state';
  var bridge = (typeof window.AgentOS !== 'undefined') ? window.AgentOS : null;

  var grid = [];
  var score = 0;
  var best = 0;
  var over = false;
  var processing = false;
  var tileId = 0;

  var elScore = document.getElementById('score');
  var elBest = document.getElementById('best');
  var elBg = document.getElementById('boardBg');
  var elTiles = document.getElementById('tiles');
  var elOverlay = document.getElementById('overlay');
  var elOverlayTitle = document.getElementById('overlayTitle');
  var elOverlayScore = document.getElementById('overlayScore');

  var COLORS = {
    '2': { bg: '#1a1a3e', fg: '#e0e0f0' },
    '4': { bg: '#2a1a4e', fg: '#e0e0f0' },
    '8': { bg: '#5b2d8e', fg: '#fff' },
    '16': { bg: '#7c3aed', fg: '#fff' },
    '32': { bg: '#9333ea', fg: '#fff' },
    '64': { bg: '#a855f7', fg: '#fff' },
    '128': { bg: '#c084fc', fg: '#0a0a0f' },
    '256': { bg: '#d8b4fe', fg: '#0a0a0f' },
    '512': { bg: '#fbbf24', fg: '#0a0a0f' },
    '1024': { bg: '#fb923c', fg: '#0a0a0f' },
    '2048': { bg: '#ff6b6b', fg: '#0a0a0f' }
  };
  var PARTICLE_COLORS = ['#8b5cf6', '#a855f7', '#c084fc', '#fbbf24', '#ff6b6b'];

  function styleFor(value) {
    var c = COLORS[String(value)] || { bg: '#2a2a3d', fg: '#e0e0e0' };
    return c;
  }

  function cellSize() {
    var w = elTiles.getBoundingClientRect().width;
    return (w - GAP * (SIZE - 1)) / SIZE;
  }

  function buildBoard() {
    elBg.innerHTML = '';
    for (var i = 0; i < SIZE * SIZE; i++) {
      var c = document.createElement('div');
      c.className = 'cell';
      elBg.appendChild(c);
    }
  }

  function blankGrid() {
    var g = [];
    for (var i = 0; i < SIZE; i++) {
      g[i] = [];
      for (var j = 0; j < SIZE; j++) g[i][j] = 0;
    }
    return g;
  }

  function emptyCells() {
    var cells = [];
    for (var i = 0; i < SIZE; i++) {
      for (var j = 0; j < SIZE; j++) {
        if (grid[i][j] === 0) cells.push({ i: i, j: j });
      }
    }
    return cells;
  }

  function addRandomTile() {
    var empty = emptyCells();
    if (empty.length === 0) return false;
    var pos = empty[Math.floor(Math.random() * empty.length)];
    grid[pos.i][pos.j] = Math.random() < 0.9 ? 2 : 4;
    return true;
  }

  function render() {
    var tiles = elTiles.querySelectorAll('.tile');
    for (var i = 0; i < tiles.length; i++) tiles[i].remove();

    var ts = cellSize();
    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) {
        var value = grid[r][c];
        if (value === 0) continue;

        var el = document.createElement('div');
        el.className = 'tile';
        el.textContent = value;
        el.style.width = ts + 'px';
        el.style.height = ts + 'px';
        el.style.transform = 'translate(' + (c * (ts + GAP)) + 'px,' + (r * (ts + GAP)) + 'px)';

        var colors = styleFor(value);
        el.style.backgroundColor = colors.bg;
        el.style.color = colors.fg;
        el.style.fontSize = (value < 100 ? 30 : value < 1000 ? 24 : 20) + 'px';

        if (value >= TARGET) el.style.boxShadow = '0 0 20px ' + colors.bg;
        elTiles.appendChild(el);
      }
    }
  }

  function slideLine(line) {
    var filtered = line.filter(function (v) { return v !== 0; });
    var result = [];
    var gained = 0;
    for (var i = 0; i < filtered.length; i++) {
      if (i + 1 < filtered.length && filtered[i] === filtered[i + 1]) {
        var merged = filtered[i] * 2;
        result.push(merged);
        gained += merged;
        i++;
      } else {
        result.push(filtered[i]);
      }
    }
    while (result.length < SIZE) result.push(0);
    return { row: result, gained: gained };
  }

  function move(direction) {
    if (over || processing) return;
    processing = true;

    var moved = false;
    var gained = 0;

    for (var i = 0; i < SIZE; i++) {
      var line = [];
      for (var j = 0; j < SIZE; j++) {
        switch (direction) {
          case 'left': line.push(grid[i][j]); break;
          case 'right': line.push(grid[i][SIZE - 1 - j]); break;
          case 'up': line.push(grid[j][i]); break;
          case 'down': line.push(grid[SIZE - 1 - j][i]); break;
        }
      }
      var out = slideLine(line);
      if (direction === 'right' || direction === 'down') out.row.reverse();

      for (var j = 0; j < SIZE; j++) {
        var r, c;
        switch (direction) {
          case 'left': r = i; c = j; break;
          case 'right': r = i; c = SIZE - 1 - j; break;
          case 'up': r = j; c = i; break;
          case 'down': r = SIZE - 1 - j; c = i; break;
        }
        if (grid[r][c] !== out.row[j]) moved = true;
        grid[r][c] = out.row[j];
      }
      gained += out.gained;
    }

    if (!moved) {
      processing = false;
      return;
    }

    score += gained;
    updateScoreboard();
    render();

    if (gained > 0) {
      spawnParticles(gained);
      playSound(Math.min(gained / 256, 1));
    }

    addRandomTile();

    if (gained > 0 && grid.some(function (row) { return row.indexOf(TARGET) !== -1; })) {
      showOverlay('You Win!', score);
      persist();
      processing = false;
      return;
    }

    if (!canMove()) {
      over = true;
      showOverlay('Game Over', score);
    }
    persist();
    processing = false;
  }

  function canMove() {
    for (var i = 0; i < SIZE; i++) {
      for (var j = 0; j < SIZE; j++) {
        if (grid[i][j] === 0) return true;
        if (j + 1 < SIZE && grid[i][j] === grid[i][j + 1]) return true;
        if (i + 1 < SIZE && grid[i][j] === grid[i + 1][j]) return true;
      }
    }
    return false;
  }

  function updateScoreboard() {
    elScore.textContent = score;
    if (score > best) {
      best = score;
      elBest.textContent = best;
    }
  }

  function showOverlay(title, finalScore) {
    elOverlayTitle.textContent = title;
    elOverlayScore.textContent = finalScore;
    elOverlay.classList.add('show');
  }

  function spawnParticles(points) {
    if (points <= 0) return;
    var boardRect = document.getElementById('board').getBoundingClientRect();
    var cx = boardRect.width / 2;
    var cy = boardRect.height / 2;
    var count = Math.min(Math.floor(points / 4), 25);

    for (var k = 0; k < count; k++) {
      var p = document.createElement('div');
      p.className = 'particle';
      var sz = 4 + Math.random() * 10;
      var angle = Math.random() * Math.PI * 2;
      var dist = 40 + Math.random() * 100;
      p.style.width = sz + 'px';
      p.style.height = sz + 'px';
      p.style.background = PARTICLE_COLORS[Math.floor(Math.random() * PARTICLE_COLORS.length)];
      p.style.left = cx + 'px';
      p.style.top = cy + 'px';
      p.style.setProperty('--dx', Math.cos(angle) * dist + 'px');
      p.style.setProperty('--dy', Math.sin(angle) * dist + 'px');
      elTiles.appendChild(p);
      setTimeout(function (el) { el.remove(); }, 700, p);
    }
  }

  var audioCtx = null;

  function playSound(intensity) {
    try {
      if (!audioCtx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        audioCtx = new AC();
      }
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      var base = 220 + intensity * 440;
      osc.type = 'sine';
      osc.frequency.setValueAtTime(base, 0);
      osc.frequency.exponentialRampToValueAtTime(base * 1.5, 0.08);
      gain.gain.setValueAtTime(0.1, 0);
      gain.gain.exponentialRampToValueAtTime(0.001, 0.12);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(0.12);
    } catch (e) { /* audio is optional */ }
  }

  function persist() {
    var payload = JSON.stringify({ grid: grid, score: score, best: best, over: over });
    if (bridge && bridge.save) {
      bridge.save(SAVE_KEY, payload);
    } else {
      try { localStorage.setItem(SAVE_KEY, payload); } catch (e) { /* storage full */ }
    }
  }

  function restore() {
    var raw = null;
    if (bridge && bridge.load) {
      raw = bridge.load(SAVE_KEY);
    } else {
      try { raw = localStorage.getItem(SAVE_KEY); } catch (e) { /* ignore */ }
    }
    if (!raw) return false;

    try {
      var data = JSON.parse(raw);
      if (!data || !data.grid || data.grid.length !== SIZE) return false;
      grid = data.grid;
      score = data.score | 0;
      best = data.best | 0;
      over = data.over === true;
      if (score < 0 || best < 0) return false;
      if (!canMove()) over = true;
      return true;
    } catch (e) {
      return false;
    }
  }

  function newGame() {
    grid = blankGrid();
    score = 0;
    best = 0;
    over = false;
    processing = false;
    elOverlay.classList.remove('show');
    elScore.textContent = '0';
    elBest.textContent = '0';
    addRandomTile();
    addRandomTile();
    render();
    persist();
  }

  function init() {
    best = 0;
    if (!restore()) {
      newGame();
      return;
    }
    elScore.textContent = score;
    elBest.textContent = best;
    render();
    if (over) showOverlay('Game Over', score);
  }

  var touchStart = null;

  function onTouchStart(e) {
    var t = e.touches[0];
    touchStart = { x: t.clientX, y: t.clientY };
  }

  function onTouchEnd(e) {
    if (!touchStart) return;
    var t = e.changedTouches[0];
    var dx = t.clientX - touchStart.x;
    var dy = t.clientY - touchStart.y;
    touchStart = null;

    var ax = Math.abs(dx);
    var ay = Math.abs(dy);
    if (Math.max(ax, ay) < 30) return;
    if (ax > ay) {
      move(dx > 0 ? 'right' : 'left');
    } else {
      move(dy > 0 ? 'down' : 'up');
    }
  }

  document.getElementById('board').addEventListener('touchstart', onTouchStart, { passive: true });
  document.getElementById('board').addEventListener('touchend', onTouchEnd, { passive: true });

  document.addEventListener('keydown', function (e) {
    var map = {
      ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down'
    };
    var dir = map[e.key];
    if (dir) {
      e.preventDefault();
      move(dir);
    }
  });

  var mouseStart = null;
  var boardEl = document.getElementById('board');
  boardEl.addEventListener('mousedown', function (e) {
    mouseStart = { x: e.clientX, y: e.clientY };
  });
  document.addEventListener('mouseup', function (e) {
    if (!mouseStart) return;
    var dx = e.clientX - mouseStart.x;
    var dy = e.clientY - mouseStart.y;
    mouseStart = null;
    var ax = Math.abs(dx);
    var ay = Math.abs(dy);
    if (Math.max(ax, ay) < 30) return;
    if (ax > ay) {
      move(dx > 0 ? 'right' : 'left');
    } else {
      move(dy > 0 ? 'down' : 'up');
    }
  });

  document.getElementById('restartBtn').addEventListener('click', newGame);
  document.getElementById('newBtn').addEventListener('click', newGame);

  buildBoard();
  init();
})();
