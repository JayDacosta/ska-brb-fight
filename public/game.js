(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const leaderboard = document.getElementById('leaderboard');
  const centerMessage = document.getElementById('centerMessage');
  const connectionDot = document.getElementById('connectionDot');
  const connectionText = document.getElementById('connectionText');

  const query = new URLSearchParams(location.search);
  const overlayKey = query.get('key') || '';
  const autoStart = query.get('autostart') !== '0';
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${location.host}/ws${overlayKey ? `?key=${encodeURIComponent(overlayKey)}` : ''}`;

  const world = {
    width: 1920,
    height: 1080,
    floorY: 835,
    leftWall: 92,
    rightWall: 1828
  };

  const state = {
    settings: {
      channel: 'skavstheworld',
      matchSeconds: 300,
      coinHit: 2,
      coinSurvive: 1,
      coinKoBonus: 12
    },
    mode: 'idle',
    startedAt: 0,
    countdownStartedAt: 0,
    matchEndsAt: 0,
    lastTime: performance.now(),
    players: new Map(),
    impacts: [],
    particles: [],
    messages: [],
    winnerSnapshot: [],
    ws: null,
    reconnectTimer: null,
    twitchConnected: false
  };

  const colors = ['#e7214f', '#ffd166', '#4cc9f0', '#7ae582', '#f8961e', '#b5179e', '#ffffff', '#90dbf4', '#caffbf'];
  const weapons = [
    { name: 'BASS', bonus: 12, color: '#ffd166' },
    { name: 'HAMMER', bonus: 18, color: '#e7214f' },
    { name: 'COMBO', bonus: 10, color: '#4cc9f0' },
    { name: 'CHAIR', bonus: 14, color: '#7ae582' }
  ];

  function fitCanvas() {
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(window.innerWidth * ratio);
    canvas.height = Math.floor(window.innerHeight * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  window.addEventListener('resize', fitCanvas);
  fitCanvas();

  function connect() {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) return;

    updateConnection(false, 'Connecting');
    const ws = new WebSocket(wsUrl);
    state.ws = ws;

    ws.addEventListener('open', () => {
      updateConnection(true, 'Overlay online');
      ws.send(JSON.stringify({ type: 'overlay-ready' }));
      if (state.mode === 'idle' && autoStart) startCountdown();
    });

    ws.addEventListener('message', event => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      handleServerEvent(data);
    });

    ws.addEventListener('close', () => {
      updateConnection(false, 'Reconnecting');
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = setTimeout(connect, 2000);
    });

    ws.addEventListener('error', () => {
      updateConnection(false, 'Connection issue');
    });
  }

  function updateConnection(online, text) {
    connectionDot.classList.toggle('online', online);
    connectionText.textContent = text;
  }

  async function loadSettings() {
    try {
      const res = await fetch(`/api/settings${overlayKey ? `?key=${encodeURIComponent(overlayKey)}` : ''}`);
      if (!res.ok) return;
      const settings = await res.json();
      Object.assign(state.settings, settings);
    } catch {}
  }

  function handleServerEvent(data) {
    if (data.type === 'hello' || data.type === 'settings') {
      Object.assign(state.settings, data.settings || {});
      state.twitchConnected = Boolean(data.twitchConnected);
      return;
    }

    if (data.type === 'twitch-status') {
      state.twitchConnected = data.connected;
      return;
    }

    if (data.type !== 'command') return;

    const command = data.command;
    if (command === 'start') return startCountdown(true);
    if (command === 'reset') return resetGame();
    if (command === 'end') return endMatch();

    processCommand({
      username: data.username || 'viewer',
      displayName: data.displayName || data.username || 'viewer',
      command,
      color: data.color
    });
  }

  function startCountdown(force = false) {
    if (!force && (state.mode === 'countdown' || state.mode === 'fight')) return;
    state.mode = 'countdown';
    state.countdownStartedAt = performance.now();
    state.winnerSnapshot = [];
    showCenter('Chat, choose violence.', 'Type !fight to enter.', 'BRB BATTLE');
  }

  function startFight() {
    state.mode = 'fight';
    state.startedAt = performance.now();
    state.matchEndsAt = state.startedAt + state.settings.matchSeconds * 1000;
    hideCenter();
    addImpact('FIGHT!', world.width / 2, 300, '#ffd166', 96);
  }

  function endMatch() {
    if (state.mode === 'results') return;
    state.mode = 'results';
    state.winnerSnapshot = getRankedPlayers().slice(0, 5).map(player => ({
      name: player.displayName,
      coins: player.bankedCoins + player.coins,
      kos: player.kos
    }));
    showResults();
  }

  function resetGame() {
    state.players.clear();
    state.impacts.length = 0;
    state.particles.length = 0;
    state.messages.length = 0;
    state.mode = 'idle';
    state.winnerSnapshot = [];
    showCenter('Ska stepped away...', 'Type !fight to enter.', 'BRB BATTLE');
    if (autoStart) setTimeout(() => startCountdown(true), 1000);
  }

  function processCommand({ username, displayName, command, color }) {
    if (!username) return;
    if (state.mode === 'results') return;
    if (state.mode === 'idle' && autoStart) startCountdown();

    let player = state.players.get(username.toLowerCase());

    if (command === 'fight') {
      if (!player) {
        player = createPlayer(username, displayName, color);
        state.players.set(username.toLowerCase(), player);
        addImpact('JOIN!', player.x, player.y - 120, player.color, 36);
      } else if (!player.alive) {
        respawnPlayer(player);
        addImpact('BACK!', player.x, player.y - 120, player.color, 34);
      } else {
        player.intent = 'wave';
        player.message = '!fight';
        player.messageUntil = performance.now() + 1100;
      }
      return;
    }

    if (!player || !player.alive) return;

    const now = performance.now();
    player.lastCommandAt = now;
    player.message = `!${command}`;
    player.messageUntil = now + 900;

    if (command === 'strike') strike(player, now);
    if (command === 'jump') jump(player, now);
    if (command === 'dash') dash(player, now);
    if (command === 'block') block(player, now);
    if (command === 'weapon') weapon(player, now);
    if (command === 'special') special(player, now);
    if (command === 'taunt') taunt(player, now);
  }

  function createPlayer(username, displayName, color) {
    const seed = hash(username);
    const side = seed % 2 === 0 ? -1 : 1;
    return {
      id: username.toLowerCase(),
      username,
      displayName,
      color: color || colors[seed % colors.length],
      accent: colors[(seed + 3) % colors.length],
      x: 260 + (seed % 1400),
      y: world.floorY,
      vx: side * (65 + (seed % 50)),
      vy: 0,
      facing: side,
      radius: 33,
      hp: 100,
      maxHp: 100,
      coins: 0,
      bankedCoins: 0,
      hits: 0,
      kos: 0,
      deaths: 0,
      alive: true,
      blockingUntil: 0,
      invulnerableUntil: performance.now() + 1000,
      weapon: null,
      weaponUntil: 0,
      cooldowns: {},
      nextSurvivalAt: performance.now() + 10000,
      message: '',
      messageUntil: 0,
      lastCommandAt: 0,
      bob: seed % 1000
    };
  }

  function respawnPlayer(player) {
    player.alive = true;
    player.hp = player.maxHp;
    player.x = 240 + Math.random() * 1440;
    player.y = world.floorY;
    player.vx = Math.random() > 0.5 ? 120 : -120;
    player.vy = 0;
    player.coins = 0;
    player.invulnerableUntil = performance.now() + 1400;
    player.nextSurvivalAt = performance.now() + 10000;
  }

  function strike(attacker, now) {
    if (cooling(attacker, 'strike', now, 700)) return;

    attacker.facing = attacker.vx >= 0 ? 1 : -1;
    const target = nearestEnemy(attacker, 132);
    const weaponBonus = attacker.weapon && now < attacker.weaponUntil ? attacker.weapon.bonus : 0;
    const damage = 18 + weaponBonus;

    addImpact(weaponBonus ? 'SMACK!' : 'POW!', attacker.x + attacker.facing * 48, attacker.y - 82, weaponBonus ? attacker.weapon.color : '#ffffff', 44);

    if (!target) return;
    hitPlayer(target, attacker, damage, now);
  }

  function jump(player, now) {
    if (cooling(player, 'jump', now, 900)) return;
    if (Math.abs(player.y - world.floorY) < 4) {
      player.vy = -520;
      addImpact('HOP!', player.x, player.y - 115, '#4cc9f0', 28);
    }
  }

  function dash(player, now) {
    if (cooling(player, 'dash', now, 1300)) return;
    const direction = player.facing || (Math.random() > 0.5 ? 1 : -1);
    player.vx = direction * 520;
    addImpact('DASH!', player.x, player.y - 115, '#4cc9f0', 30);
  }

  function block(player, now) {
    if (cooling(player, 'block', now, 2500)) return;
    player.blockingUntil = now + 1300;
    addImpact('BLOCK!', player.x, player.y - 120, '#7ae582', 30);
  }

  function weapon(player, now) {
    if (cooling(player, 'weapon', now, 9000)) return;
    const item = weapons[Math.floor(Math.random() * weapons.length)];
    player.weapon = item;
    player.weaponUntil = now + 8500;
    addImpact(item.name, player.x, player.y - 130, item.color, 40);
  }

  function special(player, now) {
    if (cooling(player, 'special', now, 15000)) return;
    addImpact('SPECIAL!', player.x, player.y - 145, '#ffd166', 52);
    burst(player.x, player.y - 70, player.color, 34);

    for (const target of state.players.values()) {
      if (target === player || !target.alive) continue;
      const dist = distance(player, target);
      if (dist < 220) hitPlayer(target, player, 24, now);
    }
  }

  function taunt(player, now) {
    if (cooling(player, 'taunt', now, 6000)) return;
    player.coins += 1;
    player.message = 'skill issue';
    player.messageUntil = now + 1200;
    addImpact('+1', player.x, player.y - 140, '#ffd166', 30);
  }

  function cooling(player, name, now, ms) {
    if ((player.cooldowns[name] || 0) > now) return true;
    player.cooldowns[name] = now + ms;
    return false;
  }

  function nearestEnemy(player, range) {
    let best = null;
    let bestDist = Infinity;
    for (const other of state.players.values()) {
      if (other === player || !other.alive) continue;
      const dx = Math.abs(other.x - player.x);
      const dy = Math.abs(other.y - player.y);
      const dist = Math.hypot(dx, dy);
      if (dist < range && dist < bestDist) {
        best = other;
        bestDist = dist;
      }
    }
    return best;
  }

  function hitPlayer(target, attacker, damage, now) {
    if (!target.alive || now < target.invulnerableUntil) return;

    const blocked = now < target.blockingUntil;
    const finalDamage = blocked ? Math.max(4, Math.round(damage * 0.35)) : damage;

    target.hp -= finalDamage;
    target.vx += attacker.x < target.x ? 260 : -260;
    target.vy = -180;

    attacker.coins += state.settings.coinHit;
    attacker.hits += 1;

    addImpact(blocked ? 'CLANG!' : `+${state.settings.coinHit}`, target.x, target.y - 125, blocked ? '#7ae582' : '#ffd166', blocked ? 32 : 28);
    burst(target.x, target.y - 60, attacker.color, 12);

    if (target.hp <= 0) koPlayer(target, attacker, now);
  }

  function koPlayer(target, attacker, now) {
    target.alive = false;
    target.deaths += 1;
    target.hp = 0;
    target.invulnerableUntil = now + 2000;

    const stolen = Math.floor(target.coins * 0.5) + state.settings.coinKoBonus;
    target.coins = 0;
    attacker.coins += stolen;
    attacker.kos += 1;

    addImpact('K.O.!', target.x, target.y - 150, '#e7214f', 70);
    addImpact(`+${stolen}`, attacker.x, attacker.y - 150, '#ffd166', 42);
    burst(target.x, target.y - 70, '#e7214f', 42);
  }

  function tick(now) {
    const dt = Math.min((now - state.lastTime) / 1000, 0.05);
    state.lastTime = now;

    if (state.mode === 'countdown') {
      const elapsed = now - state.countdownStartedAt;
      const remaining = Math.ceil(3 - elapsed / 1000);
      if (remaining > 0) {
        showCenter(String(remaining), 'Get ready...', 'TYPE !FIGHT');
      } else if (elapsed < 3900) {
        showCenter('FIGHT!', 'Type commands in chat.', 'SKA VS CHAT');
      } else {
        startFight();
      }
    }

    if (state.mode === 'fight' && now >= state.matchEndsAt) endMatch();

    updatePlayers(dt, now);
    updateEffects(dt);
    draw(now);
    updateLeaderboard();

    requestAnimationFrame(tick);
  }

  function updatePlayers(dt, now) {
    for (const player of state.players.values()) {
      player.bob += dt * 6;

      if (!player.alive) {
        player.vx *= 0.96;
        player.vy += 1100 * dt;
        player.x += player.vx * dt;
        player.y += player.vy * dt;
        if (player.y > world.floorY + 40) {
          player.y = world.floorY + 40;
          player.vy = 0;
        }
        continue;
      }

      if (state.mode === 'fight' && now > player.nextSurvivalAt) {
        player.coins += state.settings.coinSurvive;
        player.nextSurvivalAt = now + 10000;
        addImpact(`+${state.settings.coinSurvive}`, player.x, player.y - 118, '#ffd166', 24);
      }

      // Give idle players a small auto-brawler wander so the arena feels alive.
      if (Math.abs(player.vx) < 55) player.vx += (Math.random() > 0.5 ? 1 : -1) * 45;
      if (Math.random() < 0.006) player.vx += (Math.random() > 0.5 ? 1 : -1) * 140;

      player.vy += 1120 * dt;
      player.x += player.vx * dt;
      player.y += player.vy * dt;
      player.vx *= Math.abs(player.y - world.floorY) < 4 ? 0.92 : 0.985;

      if (player.y >= world.floorY) {
        player.y = world.floorY;
        player.vy = 0;
      }

      if (player.x < world.leftWall) {
        player.x = world.leftWall;
        player.vx = Math.abs(player.vx) + 80;
      }
      if (player.x > world.rightWall) {
        player.x = world.rightWall;
        player.vx = -Math.abs(player.vx) - 80;
      }

      if (Math.abs(player.vx) > 10) player.facing = player.vx > 0 ? 1 : -1;
    }
  }

  function updateEffects(dt) {
    for (const p of state.particles) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 500 * dt;
    }
    state.particles = state.particles.filter(p => p.life > 0);

    for (const impact of state.impacts) {
      impact.life -= dt;
      impact.y -= 36 * dt;
      impact.scale += 0.9 * dt;
    }
    state.impacts = state.impacts.filter(i => i.life > 0);
  }

  function draw(now) {
    const scaleX = window.innerWidth / world.width;
    const scaleY = window.innerHeight / world.height;
    ctx.save();
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    ctx.scale(scaleX, scaleY);

    drawArena(now);

    const sorted = [...state.players.values()].sort((a, b) => a.y - b.y);
    for (const player of sorted) drawPlayer(player, now);
    for (const particle of state.particles) drawParticle(particle);
    for (const impact of state.impacts) drawImpact(impact);

    drawTimer(now);
    ctx.restore();
  }

  function drawArena(now) {
    ctx.save();
    ctx.globalAlpha = 0.8;

    // Back wall panels
    for (let i = 0; i < 10; i++) {
      const x = 120 + i * 185;
      ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.035)' : 'rgba(231,33,79,0.045)';
      ctx.fillRect(x, 205 + Math.sin(now / 900 + i) * 8, 130, 390);
    }

    // Arena floor
    const gradient = ctx.createLinearGradient(0, world.floorY - 80, 0, world.height);
    gradient.addColorStop(0, 'rgba(255,255,255,0.11)');
    gradient.addColorStop(1, 'rgba(0,0,0,0.4)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(0, world.floorY + 85);
    ctx.lineTo(world.width, world.floorY + 85);
    ctx.lineTo(world.width, world.height);
    ctx.lineTo(0, world.height);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(255,255,255,0.11)';
    ctx.lineWidth = 4;
    for (let i = 0; i < 13; i++) {
      ctx.beginPath();
      ctx.moveTo(i * 170 - 80, world.floorY + 86);
      ctx.lineTo(i * 250 - 650, world.height);
      ctx.stroke();
    }
    for (let y = world.floorY + 120; y < world.height; y += 64) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(world.width, y);
      ctx.stroke();
    }

    // Big background text
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = '#ffffff';
    ctx.font = '900 190px Impact, Arial Black, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('VS', world.width / 2, 520);
    ctx.restore();
  }

  function drawPlayer(player, now) {
    const x = player.x;
    const y = player.y;
    const squish = player.alive ? Math.sin(player.bob) * 2 : 0;
    const alpha = now < player.invulnerableUntil && Math.floor(now / 100) % 2 ? 0.45 : 1;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y + squish);

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(0, 20, player.alive ? 46 : 54, 13, 0, 0, Math.PI * 2);
    ctx.fill();

    if (!player.alive) {
      ctx.rotate(0.25);
      ctx.globalAlpha *= 0.65;
    }

    // Block shield
    if (now < player.blockingUntil) {
      ctx.strokeStyle = '#7ae582';
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.arc(0, -64, 57, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Body
    ctx.fillStyle = player.color;
    roundRect(ctx, -28, -84, 56, 76, 18);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 5;
    ctx.stroke();

    // Head / avatar
    ctx.fillStyle = '#f8efe2';
    ctx.beginPath();
    ctx.arc(0, -112, 34, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#111118';
    ctx.font = '900 22px Arial Black, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials(player.displayName), 0, -111);

    // Arms
    ctx.lineCap = 'round';
    ctx.strokeStyle = player.accent;
    ctx.lineWidth = 10;
    const punch = (player.cooldowns.strike || 0) > now ? player.facing * 24 : 0;
    ctx.beginPath();
    ctx.moveTo(-25, -60);
    ctx.lineTo(-52, -36);
    ctx.moveTo(25, -60);
    ctx.lineTo(52 + punch, -40);
    ctx.stroke();

    // Legs
    ctx.strokeStyle = '#f8efe2';
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(-17, -10);
    ctx.lineTo(-27, 20);
    ctx.moveTo(17, -10);
    ctx.lineTo(28, 20);
    ctx.stroke();

    // Weapon label
    if (player.weapon && now < player.weaponUntil) {
      ctx.fillStyle = player.weapon.color;
      ctx.font = '900 24px Arial Black, sans-serif';
      ctx.fillText(player.weapon.name, 0, -166);
    }

    ctx.restore();

    drawNameplate(player, now);
  }

  function drawNameplate(player, now) {
    const x = player.x;
    const y = player.y - 185;
    const name = player.displayName;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = '900 24px Arial Black, sans-serif';
    const width = Math.min(250, ctx.measureText(name).width + 32);

    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    roundRect(ctx, x - width / 2, y - 28, width, 34, 10);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.fillText(name, x, y - 4);

    // HP bar
    const hpPct = Math.max(0, player.hp / player.maxHp);
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    roundRect(ctx, x - 66, y + 14, 132, 12, 8);
    ctx.fill();
    ctx.fillStyle = hpPct > 0.5 ? '#7ae582' : hpPct > 0.25 ? '#ffd166' : '#e7214f';
    roundRect(ctx, x - 66, y + 14, 132 * hpPct, 12, 8);
    ctx.fill();

    if (player.message && now < player.messageUntil) {
      ctx.fillStyle = 'rgba(248,239,226,0.96)';
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 3;
      ctx.font = '900 23px Arial Black, sans-serif';
      const msgWidth = Math.min(270, ctx.measureText(player.message).width + 26);
      roundRect(ctx, x - msgWidth / 2, y - 78, msgWidth, 34, 12);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#111118';
      ctx.fillText(player.message, x, y - 54);
    }

    ctx.restore();
  }

  function drawParticle(p) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawImpact(impact) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, impact.life / impact.maxLife));
    ctx.translate(impact.x, impact.y);
    ctx.rotate(impact.rotation);
    ctx.scale(impact.scale, impact.scale);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${impact.size}px Impact, Arial Black, sans-serif`;
    ctx.lineWidth = Math.max(6, impact.size * 0.12);
    ctx.strokeStyle = 'rgba(0,0,0,0.78)';
    ctx.strokeText(impact.text, 0, 0);
    ctx.fillStyle = impact.color;
    ctx.fillText(impact.text, 0, 0);
    ctx.restore();
  }

  function drawTimer(now) {
    if (state.mode !== 'fight') return;
    const remaining = Math.max(0, Math.ceil((state.matchEndsAt - now) / 1000));
    const mins = Math.floor(remaining / 60);
    const secs = String(remaining % 60).padStart(2, '0');

    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = '900 58px Arial Black, sans-serif';
    ctx.lineWidth = 9;
    ctx.strokeStyle = 'rgba(0,0,0,0.68)';
    ctx.fillStyle = '#ffffff';
    ctx.strokeText(`${mins}:${secs}`, world.width / 2, 104);
    ctx.fillText(`${mins}:${secs}`, world.width / 2, 104);
    ctx.restore();
  }

  function updateLeaderboard() {
    const ranked = state.mode === 'results'
      ? state.winnerSnapshot.map((p, index) => ({ ...p, displayName: p.name, total: p.coins, rank: index + 1 }))
      : getRankedPlayers().slice(0, 5).map((p, index) => ({
          displayName: p.displayName,
          total: p.bankedCoins + p.coins,
          kos: p.kos,
          rank: index + 1
        }));

    leaderboard.innerHTML = ranked.map(player => `
      <li>
        <span>#${player.rank}</span>
        <span>${escapeHtml(player.displayName)}</span>
        <span>${player.total}c / ${player.kos} KO</span>
      </li>
    `).join('') || '<li><span>#</span><span>Waiting for chat</span><span>0c</span></li>';
  }

  function getRankedPlayers() {
    return [...state.players.values()].sort((a, b) => {
      const coinDiff = (b.bankedCoins + b.coins) - (a.bankedCoins + a.coins);
      if (coinDiff) return coinDiff;
      return b.kos - a.kos;
    });
  }

  function showCenter(title, subtitle, kicker = 'BRB BATTLE') {
    centerMessage.classList.add('show');
    centerMessage.innerHTML = `
      <p class="kicker">${escapeHtml(kicker)}</p>
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(subtitle)}</p>
    `;
  }

  function hideCenter() {
    centerMessage.classList.remove('show');
  }

  function showResults() {
    const winners = state.winnerSnapshot;
    const lines = winners.length
      ? winners.map((p, index) => `<p><strong>#${index + 1} ${escapeHtml(p.name)}</strong> ${p.coins} coins, ${p.kos} KOs</p>`).join('')
      : '<p>No fighters joined. Chat chose peace. Weird.</p>';

    centerMessage.classList.add('show');
    centerMessage.innerHTML = `
      <p class="kicker">MATCH OVER</p>
      <h2>WINNERS</h2>
      ${lines}
      <p>Reload BRB or hit Start Match to run it back.</p>
    `;
  }

  function addImpact(text, x, y, color, size = 36) {
    state.impacts.push({
      text,
      x,
      y,
      color,
      size,
      life: 0.9,
      maxLife: 0.9,
      scale: 0.86,
      rotation: (Math.random() - 0.5) * 0.22
    });
  }

  function burst(x, y, color, count) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 120 + Math.random() * 460;
      state.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 220,
        color,
        size: 4 + Math.random() * 8,
        life: 0.45 + Math.random() * 0.5,
        maxLife: 0.95
      });
    }
  }

  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function initials(name) {
    const clean = String(name || '?').replace(/_/g, ' ').trim();
    const parts = clean.split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }

  function hash(value) {
    let h = 2166136261;
    for (let i = 0; i < value.length; i++) {
      h ^= value.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h >>> 0);
  }

  function roundRect(context, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + r, y);
    context.arcTo(x + width, y, x + width, y + height, r);
    context.arcTo(x + width, y + height, x, y + height, r);
    context.arcTo(x, y + height, x, y, r);
    context.arcTo(x, y, x + width, y, r);
    context.closePath();
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  loadSettings().finally(() => {
    connect();
    requestAnimationFrame(tick);
  });
})();
