(function(){
  'use strict';

  // ----- Config -----
  const NUM_COLS = 5;
  const NUM_ROWS = 2;
  const INITIAL_STAGE = 1; // Only combat phase implemented; keep stage fixed for now

  // Assumptions due to unspecified details:
  // - Stage.csv positions are 1-based; convert to 0-based for UI grid
  // - Targeting is column-aligned: units attack the nearest enemy in the same column only
  // - Minimum damage is at least 1 to avoid stalemates (attack - armor, clamped to >= 1)

  // ----- DOM -----
  const enemyGridEl = document.getElementById('enemyGrid');
  const playerGridEl = document.getElementById('playerGrid');
  const stageLabelEl = document.getElementById('stageLabel');
  const startButtonEl = document.getElementById('startButton');
  const unitSelectorEl = document.getElementById('unitSelector');
  const resultOverlayEl = document.getElementById('resultOverlay');
  const resultMessageEl = document.getElementById('resultMessage');
  const resultDetailsEl = document.getElementById('resultDetails');
  const restartButtonEl = document.getElementById('restartButton');

  // ----- State -----
  /** @typedef {{ index:number, name:string, attack:number, attacktime:number, hp:number, armor:number, gold:number, item:string }} MonsterDef */
  /** @typedef {{ index:number, name:string, attack:number, attacktime:number, hp:number, armor:number }} UnitDef */
  /** @typedef {{ id:string, side:'enemy'|'player', name:string, attack:number, attacktime:number, maxHp:number, hp:number, armor:number, x:number, y:number, alive:boolean, timeSinceAttack:number }} Entity */

  /** @type {Record<number, MonsterDef>} */
  let monsterDefs = {};
  /** @type {Record<number, UnitDef>} */
  let unitDefs = {};
  /** @type {Record<number, {monsterId:number, x:number, y:number}[]>} */
  let stageMap = {};

  /** @type {Entity[]} */
  let enemies = [];
  /** @type {Entity[]} */
  let players = [];

  /** @type {Record<string, HTMLElement>} */
  const entityIdToEl = {};

  let currentStage = INITIAL_STAGE;
  let isCombatActive = false;
  let rafHandle = 0;
  let lastTs = 0;

  // ----- CSV loader -----
  async function loadCSV(url){
    const res = await fetch(url);
    if(!res.ok){
      throw new Error('Failed to load '+url+': '+res.status+' '+res.statusText);
    }
    return await res.text();
  }

  function parseCSV(text){
    const lines = text.split(/\r?\n/).filter(l=>l.trim().length>0);
    // Ignore first line (headers) and second line (types)
    const dataLines = lines.slice(2);
    return dataLines.map(line => line.split(',').map(cell => cell.trim()));
  }

  function parseIntSafe(value, fallback=0){
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
  }

  function clamp(v, min, max){
    return Math.max(min, Math.min(max, v));
  }

  // ----- Data setup -----
  async function init(){
    // build grids
    buildGrid(enemyGridEl, 'enemy');
    buildGrid(playerGridEl, 'player');

    stageLabelEl.textContent = String(currentStage);

    // load CSVs in parallel
    const [stageText, monsterText, unitText] = await Promise.all([
      loadCSV('Stage.csv'),
      loadCSV('Monster.csv'),
      loadCSV('Unit.csv'),
    ]);

    // Stage rows: [stage, monsterIdx, x, y]
    const stageRows = parseCSV(stageText);
    stageMap = {};
    for(const row of stageRows){
      if(row.length < 4) continue;
      const stage = parseIntSafe(row[0]);
      const monsterId = parseIntSafe(row[1]);
      // Convert to 0-based coordinates
      const x = clamp(parseIntSafe(row[2]) - 1, 0, NUM_COLS - 1);
      const y = clamp(parseIntSafe(row[3]) - 1, 0, NUM_ROWS - 1);
      if(!stageMap[stage]) stageMap[stage] = [];
      stageMap[stage].push({ monsterId, x, y });
    }

    // Monster defs
    const monsterRows = parseCSV(monsterText);
    monsterDefs = {};
    for(const row of monsterRows){
      if(row.length < 8) continue;
      const index = parseIntSafe(row[0]);
      monsterDefs[index] = {
        index,
        name: row[1],
        attack: parseIntSafe(row[2]),
        attacktime: parseIntSafe(row[3]),
        hp: parseIntSafe(row[4]),
        armor: parseIntSafe(row[5]),
        gold: parseIntSafe(row[6]),
        item: row[7] || '',
      };
    }

    // Unit defs
    const unitRows = parseCSV(unitText);
    unitDefs = {};
    for(const row of unitRows){
      if(row.length < 6) continue;
      const index = parseIntSafe(row[0]);
      unitDefs[index] = {
        index,
        name: row[1],
        attack: parseIntSafe(row[2]),
        attacktime: parseIntSafe(row[3]),
        hp: parseIntSafe(row[4]),
        armor: parseIntSafe(row[5]),
      };
    }

    // Populate unit selector
    populateUnitSelector();

    // Compose enemies for the current stage
    resetEnemiesToStage(currentStage);

    // Hook events
    startButtonEl.addEventListener('click', onStartCombat);
    restartButtonEl.addEventListener('click', onRestart);

    // Allow player placement before combat
    enablePlayerPlacement(true);
  }

  function buildGrid(container, side){
    container.innerHTML = '';
    container.style.setProperty('--cols', String(NUM_COLS));
    container.style.setProperty('--rows', String(NUM_ROWS));
    for(let y=0; y<NUM_ROWS; y++){
      for(let x=0; x<NUM_COLS; x++){
        const cell = document.createElement('div');
        cell.className = 'cell' + (side==='player' ? ' player-drop' : '');
        cell.dataset.x = String(x);
        cell.dataset.y = String(y);
        if(side==='player'){
          cell.addEventListener('click', () => onPlayerCellClick(x,y));
        }
        container.appendChild(cell);
      }
    }
  }

  function populateUnitSelector(){
    unitSelectorEl.innerHTML = '<option value="" selected>선택...</option>';
    const ids = Object.keys(unitDefs).map(n=>parseInt(n,10)).sort((a,b)=>a-b);
    for(const id of ids){
      const def = unitDefs[id];
      const opt = document.createElement('option');
      opt.value = String(def.index);
      opt.textContent = `#${def.index} ${def.name} (ATK ${def.attack}, HP ${def.hp})`;
      unitSelectorEl.appendChild(opt);
    }
  }

  function onPlayerCellClick(x, y){
    if(isCombatActive) return;
    const selected = unitSelectorEl.value.trim();
    const cellEl = getPlayerCellEl(x,y);
    if(!selected){
      // If occupied, remove unit
      const existing = players.find(p=>p.x===x && p.y===y && p.alive);
      if(existing){
        removeEntity(existing);
        players = players.filter(p=>p.id!==existing.id);
      }
      return;
    }
    const unitId = parseIntSafe(selected);
    const def = unitDefs[unitId];
    if(!def) return;

    // toggle placement: if occupied, replace
    const occupied = players.find(p=>p.x===x && p.y===y);
    if(occupied){
      removeEntity(occupied);
      players = players.filter(p=>p.id!==occupied.id);
    }
    const entity = createEntityFromUnitDef(def, x, y);
    players.push(entity);
    mountEntityEl(entity);
  }

  function getPlayerCellEl(x,y){
    return playerGridEl.querySelector(`.cell[data-x="${x}"][data-y="${y}"]`);
  }
  function getEnemyCellEl(x,y){
    return enemyGridEl.querySelector(`.cell[data-x="${x}"][data-y="${y}"]`);
  }

  function createEntityFromUnitDef(def, x, y){
    /** @type {Entity} */
    return {
      id: `P_${Math.random().toString(36).slice(2)}`,
      side: 'player',
      name: def.name,
      attack: def.attack,
      attacktime: Math.max(100, def.attacktime),
      maxHp: def.hp,
      hp: def.hp,
      armor: def.armor,
      x, y,
      alive: true,
      timeSinceAttack: 0,
    };
  }
  function createEntityFromMonsterDef(def, x, y){
    /** @type {Entity} */
    return {
      id: `E_${Math.random().toString(36).slice(2)}`,
      side: 'enemy',
      name: def.name,
      attack: def.attack,
      attacktime: Math.max(100, def.attacktime),
      maxHp: def.hp,
      hp: def.hp,
      armor: def.armor,
      x, y,
      alive: true,
      timeSinceAttack: 0,
    };
  }

  function mountEntityEl(entity){
    const container = entity.side==='enemy' ? getEnemyCellEl(entity.x, entity.y) : getPlayerCellEl(entity.x, entity.y);
    if(!container) return;
    const el = document.createElement('div');
    el.className = `entity ${entity.side}`;
    el.dataset.entityId = entity.id;

    const nameEl = document.createElement('div');
    nameEl.className = 'entity-name';
    nameEl.textContent = entity.name;

    const hpbar = document.createElement('div');
    hpbar.className = 'hpbar';
    const fill = document.createElement('div');
    fill.className = 'fill';
    hpbar.appendChild(fill);

    el.appendChild(nameEl);
    el.appendChild(hpbar);

    container.innerHTML = '';
    container.appendChild(el);

    entityIdToEl[entity.id] = el;
    updateHpBar(entity);
  }

  function updateHpBar(entity){
    const el = entityIdToEl[entity.id];
    if(!el) return;
    const pct = clamp(entity.hp / entity.maxHp, 0, 1);
    const bar = el.querySelector('.hpbar');
    const fill = el.querySelector('.hpbar .fill');
    if(fill){
      fill.style.width = `${pct*100}%`;
    }
    if(bar){
      bar.classList.toggle('danger', pct <= 0.3);
    }
    el.classList.toggle('dead', !entity.alive);
  }

  function removeEntity(entity){
    const el = entityIdToEl[entity.id];
    if(el && el.parentElement){
      el.parentElement.innerHTML = '';
    }
    delete entityIdToEl[entity.id];
  }

  function resetEnemiesToStage(stage){
    // Clear enemy cells
    for(const cell of enemyGridEl.querySelectorAll('.cell')){
      cell.innerHTML = '';
    }
    enemies = [];

    const placements = stageMap[stage] || [];
    for(const pl of placements){
      const def = monsterDefs[pl.monsterId];
      if(!def) continue;
      const entity = createEntityFromMonsterDef(def, pl.x, pl.y);
      enemies.push(entity);
      mountEntityEl(entity);
    }
  }

  function enablePlayerPlacement(enabled){
    for(const cell of playerGridEl.querySelectorAll('.cell')){
      if(enabled) cell.classList.add('player-drop');
      else cell.classList.remove('player-drop');
    }
    unitSelectorEl.disabled = !enabled;
  }

  function onStartCombat(){
    if(isCombatActive) return;
    if(players.filter(p=>p.alive).length === 0){
      alert('유닛을 배치하세요.');
      return;
    }
    isCombatActive = true;
    startButtonEl.disabled = true;
    startButtonEl.style.display = 'none';
    enablePlayerPlacement(false);

    lastTs = performance.now();
    rafHandle = requestAnimationFrame(gameLoop);
  }

  function onRestart(){
    // Hide overlay
    resultOverlayEl.classList.add('hidden');

    // Reset entities
    for(const e of enemies){
      e.hp = e.maxHp; e.alive = true; e.timeSinceAttack = 0;
      mountEntityEl(e);
    }
    for(const p of players){
      p.hp = p.maxHp; p.alive = true; p.timeSinceAttack = 0;
      mountEntityEl(p);
    }

    // Reset controls
    isCombatActive = false;
    startButtonEl.disabled = false;
    startButtonEl.style.display = '';
    enablePlayerPlacement(true);
  }

  function gameLoop(ts){
    const dt = ts - lastTs;
    lastTs = ts;

    // Update enemies then players (order shouldn't matter due to independent timers)
    tickSide(enemies, players, dt, /*enemyTargets*/true);
    tickSide(players, enemies, dt, /*enemyTargets*/false);

    // Check outcomes
    if(checkVictory()){
      endCombat(true);
      return;
    }
    if(checkDefeat()){
      endCombat(false);
      return;
    }

    if(isCombatActive){
      rafHandle = requestAnimationFrame(gameLoop);
    }
  }

  function tickSide(attackers, defenders, dt, attackerIsEnemy){
    for(const a of attackers){
      if(!a.alive) continue;
      a.timeSinceAttack += dt;
      if(a.timeSinceAttack < a.attacktime) continue;

      const target = acquireTarget(a, defenders, attackerIsEnemy);
      if(!target){
        // No target in the same column; wait
        a.timeSinceAttack = 0; // keep cadence even if no target
        continue;
      }

      // Attack
      const raw = a.attack - target.armor;
      const dmg = Math.max(1, raw); // see assumption
      target.hp = Math.max(0, target.hp - dmg);
      if(target.hp === 0){
        target.alive = false;
      }
      updateHpBar(target);

      a.timeSinceAttack = 0;
    }
  }

  function acquireTarget(attacker, defenders, attackerIsEnemy){
    // Column-aligned targeting only
    const sameCol = defenders.filter(d=>d.alive && d.x === attacker.x);
    if(sameCol.length === 0) return null;
    // Nearest by row toward the middle gap
    if(attackerIsEnemy){
      // Enemy is above; nearest player row is y=0 (top row)
      sameCol.sort((a,b)=> a.y - b.y); // ascending: 0,1...
    }else{
      // Player is below; nearest enemy row is y=1 (bottom row)
      sameCol.sort((a,b)=> b.y - a.y); // descending: 1,0...
    }
    return sameCol[0] || null;
  }

  function checkVictory(){
    return enemies.length > 0 && enemies.every(e=>!e.alive);
  }
  function checkDefeat(){
    return players.length > 0 && players.every(p=>!p.alive);
  }

  function endCombat(victory){
    isCombatActive = false;
    cancelAnimationFrame(rafHandle);

    // Compose rewards if victory
    if(victory){
      resultMessageEl.textContent = '플레이어의 승리';
      const placements = stageMap[currentStage] || [];
      let totalGold = 0; let items = [];
      for(const pl of placements){
        const def = monsterDefs[pl.monsterId];
        if(!def) continue;
        totalGold += def.gold || 0;
        if(def.item) items.push(def.item);
      }
      const itemStr = items.join(', ');
      resultDetailsEl.textContent = `보상: ${totalGold} gold\n아이템: ${itemStr || '-'}\n`;
    } else {
      resultMessageEl.textContent = '플레이어의 패배';
      resultDetailsEl.textContent = '';
    }

    resultOverlayEl.classList.remove('hidden');
  }

  // Expose some helpers for debug in console
  window.__COMBAT_DEBUG__ = {
    get enemies(){ return enemies; },
    get players(){ return players; },
    resetEnemiesToStage,
  };

  // Mount existing player entities (if any) to grid
  function refreshAllEntities(){
    for(const e of enemies){ mountEntityEl(e); }
    for(const p of players){ mountEntityEl(p); }
  }

  // Initialize after DOM is ready
  window.addEventListener('DOMContentLoaded', init);
})();
