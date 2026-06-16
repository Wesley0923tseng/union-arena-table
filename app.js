const zones = {
  deck: [],
  hand: [],
  front: [],
  energy: [],
  life: [],
  ap: [],
  public: [],
  sideline: [],
  removal: [],
};

const phases = ["Start", "Movement", "Main", "Attack", "End"];
const limitedZones = new Set(["front", "energy"]);
const state = {
  cards: new Map(),
  selected: new Set(),
  history: [],
  log: [],
  activePlayer: 1,
  phaseIndex: 0,
  nextId: 1,
  contextCardId: null,
  contextStackEntry: null,
};

let suppressNextClick = false;
const activeTouchCards = new Map();
let twoFingerMenuCardId = null;
let suppressClickUntil = 0;
let handTwoFingerScroll = false;
let handTwoFingerGesture = null;
let touchDragBlockUntil = 0;
let activeZoneDialog = null;
let suppressHandContextMenuUntil = 0;
let lastHandWheelAt = 0;

const template = document.querySelector("#cardTemplate");
const menu = document.querySelector("#contextMenu");
const dialog = document.querySelector("#cardDialog");
const dialogImage = document.querySelector("#dialogImage");
const importDialog = document.querySelector("#importDialog");
const stackDialog = document.querySelector("#stackDialog");
const stackDialogTitle = document.querySelector("#stackDialogTitle");
const stackCards = document.querySelector("#stackCards");
const layoutStorageKey = "ua-table-layout-v2";
const defaultLayoutState = {
  leftCol: 250,
  rightCol: 250,
  front: 1,
  energy: 1,
  hand: 1,
};
const layoutState = {
  ...defaultLayoutState,
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function loadLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem(layoutStorageKey) || "{}");
    Object.assign(layoutState, saved);
  } catch {
    localStorage.removeItem(layoutStorageKey);
  }
}

function saveLayout() {
  localStorage.setItem(layoutStorageKey, JSON.stringify(layoutState));
}

function applyLayout() {
  const root = document.documentElement;
  const totalField = layoutState.front + layoutState.energy + layoutState.hand;
  root.style.setProperty("--left-col", `${layoutState.leftCol}px`);
  root.style.setProperty("--right-col", `${layoutState.rightCol}px`);
  root.style.setProperty("--front-row", `${layoutState.front}fr`);
  root.style.setProperty("--energy-row", `${layoutState.energy}fr`);
  root.style.setProperty("--hand-row-size", `${layoutState.hand}fr`);
  root.style.setProperty("--front-share", String(layoutState.front / totalField));
  root.style.setProperty("--front-energy-share", String((layoutState.front + layoutState.energy) / totalField));
  root.style.setProperty("--front-energy-split", String(layoutState.front / (layoutState.front + layoutState.energy)));
}

function fitStageToViewport() {
  const stage = document.querySelector("#appStage");
  if (!stage) return;
  const padding = 4;
  const viewport = window.visualViewport;
  const viewportWidth = viewport?.width || window.innerWidth;
  const viewportHeight = viewport?.height || window.innerHeight;
  const offsetLeft = viewport?.offsetLeft || 0;
  const offsetTop = viewport?.offsetTop || 0;
  const stageWidth = 1180;
  const compactLandscape = viewportWidth > viewportHeight && viewportHeight < 620;
  const stageHeight = compactLandscape ? 560 : 720;
  document.documentElement.style.setProperty("--stage-w", `${stageWidth}px`);
  document.documentElement.style.setProperty("--stage-h", `${stageHeight}px`);
  const scale = Math.min((viewportWidth - padding) / stageWidth, (viewportHeight - padding) / stageHeight, 1.18);
  const safeScale = Math.max(0.1, scale);
  const x = compactLandscape ? 0 : Math.max(0, (viewportWidth - stageWidth * safeScale) / 2);
  const y = compactLandscape ? 0 : Math.max(0, (viewportHeight - stageHeight * safeScale) / 2);
  stage.style.transform = `translate(${offsetLeft + x}px, ${offsetTop + y}px) scale(${safeScale})`;
}

function cloneStack(stack) {
  return stack.map((entry) => (typeof entry === "string" ? entry : { ...entry, stack: cloneStack(entry.stack || []) }));
}

function uprightStack(stack) {
  return cloneStack(stack).map((entry) => {
    if (typeof entry === "string") {
      const card = state.cards.get(entry);
      if (card) card.resting = false;
      return entry;
    }
    return { ...entry, resting: false, stack: uprightStack(entry.stack || []) };
  });
}

function visibleCardSnapshot(card) {
  return {
    id: `stack-${state.nextId++}`,
    name: card.name,
    image: card.image,
    faceDown: card.faceDown,
    resting: false,
    stack: [],
    ap: card.ap,
  };
}

function sourceCardSnapshot(card) {
  return {
    id: `stack-${state.nextId++}`,
    name: card.name,
    image: card.image,
    faceDown: card.faceDown,
    resting: false,
    stack: uprightStack(card.stack || []),
    ap: card.ap,
  };
}

function resolveStackEntry(entry) {
  if (typeof entry === "string") return state.cards.get(entry);
  return entry;
}

function createCardFromStackEntry(entry) {
  const stacked = resolveStackEntry(entry);
  if (!stacked) return null;
  const card = {
    ...stacked,
    id: typeof entry === "string" ? entry : `c-${state.nextId++}`,
    resting: false,
    stack: [],
  };
  state.cards.set(card.id, card);
  return card;
}

function stackCardOntoTarget(sourceId, targetId) {
  if (sourceId === targetId) return false;
  const source = state.cards.get(sourceId);
  const target = state.cards.get(targetId);
  if (!source || !target) return false;
  if (!["front", "energy"].includes(findZone(targetId))) {
    addLog("Raid ?芾? Front Line ??Energy Line ??銝?");
    render();
    return false;
  }

  const sourceSnapshot = sourceCardSnapshot(source);
  removeFromZone(sourceId);

  if (source.faceDown) {
    target.stack = [sourceSnapshot, ...uprightStack(target.stack)];
  } else {
    const targetSnapshot = visibleCardSnapshot(target);
    target.stack = [...uprightStack(target.stack), targetSnapshot, ...uprightStack(source.stack)];
    target.image = source.image || target.image;
    target.name = source.name;
    target.faceDown = false;
  }

  state.cards.delete(sourceId);
  target.resting = false;
  state.selected.clear();
  return true;
}

function cloneZones() {
  return Object.fromEntries(Object.entries(zones).map(([name, ids]) => [name, [...ids]]));
}

function snapshot() {
  return {
    zones: cloneZones(),
    cards: Array.from(state.cards.values()).map((card) => ({ ...card, stack: cloneStack(card.stack) })),
    selected: [...state.selected],
    activePlayer: state.activePlayer,
    phaseIndex: state.phaseIndex,
    nextId: state.nextId,
    log: [...state.log],
  };
}

function restore(snap) {
  Object.keys(zones).forEach((name) => {
    zones[name] = [...snap.zones[name]];
  });
  state.cards = new Map(snap.cards.map((card) => [card.id, { ...card, stack: cloneStack(card.stack) }]));
  state.selected = new Set(snap.selected);
  state.activePlayer = snap.activePlayer;
  state.phaseIndex = snap.phaseIndex;
  state.nextId = snap.nextId;
  state.log = [...snap.log];
  render();
}

function commit(message) {
  state.history.push(snapshot());
  if (state.history.length > 80) state.history.shift();
  addLog(message);
}

function addLog(message) {
  const time = new Date().toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" });
  state.log.unshift(`${time} ${message}`);
  state.log = state.log.slice(0, 80);
}

function cardName(card) {
  return card.name || `Card ${card.id}`;
}

function zoneLabel(zone) {
  const labels = {
    deck: "牌庫",
    hand: "手牌",
    front: "Front",
    energy: "Energy",
    life: "生命",
    ap: "AP",
    public: "公開區",
    sideline: "Sideline",
    removal: "Removal",
  };
  return labels[zone] || zone;
}

function findZone(cardId) {
  return Object.entries(zones).find(([, ids]) => ids.includes(cardId))?.[0] || null;
}

function removeFromZone(cardId) {
  const zone = findZone(cardId);
  if (!zone) return null;
  zones[zone] = zones[zone].filter((id) => id !== cardId);
  return zone;
}

function normalizeForZone(card, zone) {
  if (zone === "deck" || zone === "life") card.faceDown = true;
  if (zone === "hand") card.faceDown = false;
  if (zone === "sideline" || zone === "removal" || zone === "public") card.faceDown = false;
  if (zone === "front" || zone === "energy" || zone === "ap") card.faceDown = false;
  if (zone !== "front" && zone !== "energy") card.resting = false;
  if (zone === "front" || zone === "energy") card.resting = true;
}

function canAccept(zone, movingIds) {
  if (!limitedZones.has(zone)) return true;
  const current = zones[zone].length;
  const alreadyThere = movingIds.filter((id) => findZone(id) === zone).length;
  return current - alreadyThere + movingIds.length <= 4;
}

function moveCards(cardIds, destination, options = {}) {
  const ids = [...new Set(cardIds)].filter((id) => state.cards.has(id));
  if (!ids.length) return;
  if (!canAccept(destination, ids) && !options.force) {
    addLog(`${zoneLabel(destination)} 已滿，請先把一張牌移到 Removal`);
    render();
    return;
  }

  commit(`移動 ${ids.length} 張到 ${zoneLabel(destination)}`);
  ids.forEach((id) => {
    const sourceZone = removeFromZone(id);
    const card = state.cards.get(id);
    if (!["front", "energy"].includes(destination) && card.stack.length) {
      card.stack.forEach((entry) => {
        const stackedCard = createCardFromStackEntry(entry);
        if (!stackedCard) return;
        normalizeForZone(stackedCard, destination);
        if (destination === "deck" && options.deckPosition === "bottom") {
          zones.deck.unshift(stackedCard.id);
        } else {
          zones[destination].push(stackedCard.id);
        }
      });
      card.stack = [];
    }
    if (["front", "energy"].includes(sourceZone) && ["front", "energy"].includes(destination)) {
      card.faceDown = false;
    } else {
      normalizeForZone(card, destination);
    }
    if (destination === "deck" && options.deckPosition === "bottom") {
      zones.deck.unshift(id);
    } else {
      zones[destination].push(id);
    }
  });
  state.selected.clear();
  render();
}

function topCard(zone = "deck") {
  return zones[zone][zones[zone].length - 1];
}

function shuffleDeck() {
  if (zones.deck.length < 2) return;
  commit("洗牌");
  for (let i = zones.deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [zones.deck[i], zones.deck[j]] = [zones.deck[j], zones.deck[i]];
  }
  zones.deck.forEach((id) => {
    state.cards.get(id).faceDown = true;
  });
  render();
}

function shuffleDeckIds() {
  for (let i = zones.deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [zones.deck[i], zones.deck[j]] = [zones.deck[j], zones.deck[i]];
  }
  zones.deck.forEach((id) => {
    const card = state.cards.get(id);
    card.faceDown = true;
    card.resting = false;
  });
}

function moveAllToDeck(options = {}) {
  const exclude = new Set(options.exclude || []);
  Object.keys(zones).forEach((zone) => {
    if (zone === "deck") return;
    if (zone === "ap") return;
    if (exclude.has(zone)) return;
    zones[zone].forEach((id) => {
      const card = state.cards.get(id);
      if (!card) return;
      card.faceDown = true;
      card.resting = false;
      zones.deck.push(id);
    });
    zones[zone] = [];
  });
}

function resetApCards() {
  zones.ap.forEach((id) => state.cards.delete(id));
  zones.ap = [];
  for (let i = 0; i < 3; i += 1) {
    const card = {
      id: `ap-${state.nextId++}`,
      name: "AP Card",
      image: "",
      faceDown: false,
      resting: false,
      stack: [],
      ap: true,
    };
    state.cards.set(card.id, card);
    zones.ap.push(card.id);
  }
}

function openingHand() {
  commit("開局：全部回牌庫、洗牌、抽 7 手牌、設置 7 生命");
  moveAllToDeck();
  resetApCards();
  shuffleDeckIds();
  const drawn = [];
  for (let i = 0; i < 7; i += 1) {
    const id = topCard();
    if (!id) break;
    drawn.push(id);
    zones.deck.pop();
  }
  drawn.forEach((id) => {
    const card = state.cards.get(id);
    card.faceDown = false;
    card.resting = false;
    zones.hand.push(id);
  });
  for (let i = 0; i < 7; i += 1) {
    const id = topCard();
    if (!id) break;
    zones.deck.pop();
    const card = state.cards.get(id);
    card.faceDown = true;
    card.resting = false;
    zones.life.push(id);
  }
  state.selected.clear();
  render();
}

function mulligan() {
  if (!zones.life.length) {
    addLog("沒有生命可調度");
    render();
    return;
  }
  commit("調度：非生命回洗，生命進手牌，重發 7 生命");
  moveAllToDeck({ exclude: ["life"] });
  shuffleDeckIds();
  const oldLife = [...zones.life];
  zones.life = [];
  oldLife.forEach((id) => {
    const card = state.cards.get(id);
    card.faceDown = false;
    card.resting = false;
    zones.hand.push(id);
  });
  for (let i = 0; i < 7; i += 1) {
    const id = topCard();
    if (!id) break;
    zones.deck.pop();
    const card = state.cards.get(id);
    card.faceDown = true;
    card.resting = false;
    zones.life.push(id);
  }
  state.selected.clear();
  render();
}

function draw(count) {
  const drawn = [];
  for (let i = 0; i < count; i += 1) {
    const id = topCard();
    if (!id) break;
    drawn.push(id);
    zones.deck.pop();
  }
  if (!drawn.length) {
    addLog("牌庫沒有牌可抽");
    render();
    return;
  }
  commit(`抽 ${drawn.length} 張`);
  drawn.forEach((id) => {
    const card = state.cards.get(id);
    card.faceDown = false;
    card.resting = false;
    zones.hand.push(id);
  });
  render();
}

function setupLife() {
  const moved = [];
  for (let i = 0; i < 7; i += 1) {
    const id = topCard();
    if (!id) break;
    moved.push(id);
    zones.deck.pop();
  }
  if (!moved.length) return;
  commit(`設置 ${moved.length} 張生命`);
  moved.forEach((id) => {
    const card = state.cards.get(id);
    card.faceDown = true;
    card.resting = false;
    zones.life.push(id);
  });
  render();
}

function revealTop() {
  const id = topCard();
  if (!id) return;
  moveCards([id], "public");
}

function peekTop() {
  const id = topCard();
  if (!id) {
    addLog("牌庫沒有牌頂");
    render();
    return;
  }
  const card = state.cards.get(id);
  showCard(card);
  addLog(`查看牌頂：${cardName(card)}`);
  render();
}

function takeDamage(count) {
  const damaged = zones.life.slice(-count);
  if (!damaged.length) {
    addLog("生命已經是 0");
    render();
    return;
  }
  commit(`受到 ${damaged.length} 傷害，翻生命檢查 Trigger`);
  damaged.forEach((id) => {
    zones.life.pop();
    const card = state.cards.get(id);
    card.faceDown = false;
    card.resting = false;
    zones.public.push(id);
  });
  render();
}

function readyZones(includeAp) {
  commit(includeAp ? "全部轉直" : "角色/Site 轉直");
  [...zones.front, ...zones.energy, ...(includeAp ? zones.ap : [])].forEach((id) => {
    state.cards.get(id).resting = false;
  });
  render();
}

function toggleCard(cardId, prop) {
  const card = state.cards.get(cardId);
  if (!card) return;
  if (prop === "resting" && !["front", "energy", "ap"].includes(findZone(cardId))) {
    addLog("只有 Front Line、Energy Line 或 AP 的牌可以橫置");
    render();
    return;
  }
  commit(`${prop === "faceDown" ? "翻面" : "橫置/直立"}：${cardName(card)}`);
  card[prop] = !card[prop];
  render();
}

function stackOntoSelected(cardId) {
  const targets = [...state.selected].filter((id) => id !== cardId);
  const targetId = targets[0];
  if (!targetId) {
    addLog("請先選取要被 Raid 疊上的角色");
    render();
    return;
  }
  const source = state.cards.get(cardId);
  const target = state.cards.get(targetId);
  if (!source || !target) return;
  if (!["front", "energy"].includes(findZone(targetId))) {
    addLog("Raid 只能疊在 Front Line 或 Energy Line 的牌上");
    render();
    return;
  }
  commit(`Raid 疊牌：${cardName(source)} 疊到 ${cardName(target)}`);
  stackCardOntoTarget(cardId, targetId);
  render();
}

function raidCardOnto(sourceId, targetId) {
  if (sourceId === targetId) return;
  const source = state.cards.get(sourceId);
  const target = state.cards.get(targetId);
  if (!source || !target) return;
  if (!["front", "energy"].includes(findZone(targetId))) {
    addLog("Raid 只能疊在 Front Line 或 Energy Line 的牌上");
    render();
    return;
  }
  commit(`Raid 疊牌：${cardName(source)} 疊到 ${cardName(target)}`);
  stackCardOntoTarget(sourceId, targetId);
  render();
}

function moveStackEntry(parentId, index, destination) {
  const parent = state.cards.get(parentId);
  if (!parent || !parent.stack[index]) return;
  const entry = parent.stack[index];
  const stacked = resolveStackEntry(entry);
  if (!stacked) return;
  commit(`Move stacked card to ${zoneLabel(destination)}: ${cardName(stacked)}`);
  parent.stack.splice(index, 1);

  let cardToMove;
  if (typeof entry === "string") {
    cardToMove = state.cards.get(entry);
  } else {
    cardToMove = {
      ...entry,
      id: `c-${state.nextId++}`,
      stack: cloneStack(entry.stack || []),
    };
    state.cards.set(cardToMove.id, cardToMove);
  }

  cardToMove.resting = false;
  normalizeForZone(cardToMove, destination);
  zones[destination].push(cardToMove.id);
  state.selected.clear();
  render();

  if (parent.stack.length) showStack(parentId);
  else stackDialog.close();
}

function showCard(card) {
  if (!card) return;
  dialogImage.src = card.image || "";
  dialogImage.alt = cardName(card);
  if (card.image) dialog.showModal();
}

function showStack(cardId) {
  activeZoneDialog = null;
  const card = state.cards.get(cardId);
  if (!card) return;
  stackDialogTitle.textContent = "下方卡牌";
  stackCards.innerHTML = "";
  if (!card.stack.length) {
    const empty = document.createElement("p");
    empty.className = "empty-stack";
    empty.textContent = "這張牌下方沒有卡牌。";
    stackCards.appendChild(empty);
  } else {
    card.stack.map((entry, index) => ({ entry, index })).reverse().forEach(({ entry, index }) => {
      const stacked = resolveStackEntry(entry);
      if (!stacked) return;
      stacked.resting = false;
      const node = template.content.firstElementChild.cloneNode(true);
      node.draggable = false;
      node.dataset.stackParentId = cardId;
      node.dataset.stackIndex = String(index);
      node.classList.add("stack-entry-card");
      node.classList.toggle("face-down", stacked.faceDown);
      node.classList.remove("resting");
      node.classList.toggle("has-stack", stacked.stack.length > 0);
      node.querySelector("img").src = stacked.image || "";
      node.querySelector("img").alt = cardName(stacked);
      node.querySelector(".stack-badge").textContent = stacked.stack.length + 1;
      if (stacked.faceDown) {
        const faceLabel = document.createElement("span");
        faceLabel.className = "face-state-label";
        faceLabel.textContent = "背面";
        node.appendChild(faceLabel);
      }
      node.addEventListener("click", (event) => {
        event.stopPropagation();
        showCard(stacked);
      });
      let stackTouchMenu = null;
      node.addEventListener("touchstart", (event) => {
        if (event.targetTouches.length < 2) return;
        event.preventDefault();
        event.stopPropagation();
        const center = touchCenter(event.targetTouches);
        stackTouchMenu = { x: center.clientX, y: center.clientY, moved: false };
      }, { passive: false });
      node.addEventListener("touchmove", (event) => {
        if (!stackTouchMenu || event.targetTouches.length < 2) return;
        const center = touchCenter(event.targetTouches);
        if (Math.hypot(center.clientX - stackTouchMenu.x, center.clientY - stackTouchMenu.y) > 8) {
          stackTouchMenu.moved = true;
        }
      }, { passive: true });
      node.addEventListener("touchend", (event) => {
        if (!stackTouchMenu || event.targetTouches.length >= 2) return;
        const gesture = stackTouchMenu;
        stackTouchMenu = null;
        if (gesture.moved) return;
        event.preventDefault();
        event.stopPropagation();
        openStackEntryMenu(cardId, index, { clientX: gesture.x, clientY: gesture.y });
      }, { passive: false });
      const item = document.createElement("div");
      item.className = "stack-card-entry";
      const actions = document.createElement("div");
      actions.className = "stack-card-actions";
      const toHand = document.createElement("button");
      toHand.type = "button";
      toHand.textContent = "進手牌";
      toHand.addEventListener("click", (event) => {
        event.stopPropagation();
        moveStackEntry(cardId, index, "hand");
      });
      const toSideline = document.createElement("button");
      toSideline.type = "button";
      toSideline.textContent = "進 Sideline";
      toSideline.addEventListener("click", (event) => {
        event.stopPropagation();
        moveStackEntry(cardId, index, "sideline");
      });
      actions.append(toHand, toSideline);
      stackCards.appendChild(node);
    });
  }
  stackDialog.showModal();
}

function showZoneCards(zone) {
  activeZoneDialog = zone;
  stackDialogTitle.textContent = zoneLabel(zone);
  stackCards.innerHTML = "";
  if (!zones[zone].length) {
    const empty = document.createElement("p");
    empty.className = "empty-stack";
    empty.textContent = `${zoneLabel(zone)} 沒有卡牌。`;
    stackCards.appendChild(empty);
  } else {
    zones[zone].forEach((id) => {
      const card = state.cards.get(id);
      if (!card) return;
      const node = createCardElement(card, { zone });
      stackCards.appendChild(node);
    });
  }
  stackDialog.showModal();
}

function setPhase(delta) {
  state.phaseIndex = (state.phaseIndex + delta + phases.length) % phases.length;
  if (delta > 0 && state.phaseIndex === 0) state.activePlayer = state.activePlayer === 1 ? 2 : 1;
  addLog(`進入 ${phases[state.phaseIndex]} Phase`);
  render();
}

function importFiles(files) {
  const imageFiles = [...files].filter((file) => file.type.startsWith("image/"));
  if (!imageFiles.length) return;
  commit(`匯入 ${imageFiles.length} 張到牌庫`);
  imageFiles.forEach((file) => {
    const id = `c-${state.nextId++}`;
    const card = {
      id,
      name: file.name.replace(/\.[^.]+$/, ""),
      image: URL.createObjectURL(file),
      faceDown: true,
      resting: false,
      stack: [],
      ap: false,
    };
    state.cards.set(id, card);
    zones.deck.push(id);
  });
  render();
}

function absoluteUrl(src, baseUrl) {
  if (!src) return "";
  try {
    return new URL(src, baseUrl || window.location.href).href;
  } catch {
    return src;
  }
}

function parseQuantity(text) {
  const normalized = String(text || "").replace(/\s+/g, " ");
  const patterns = [
    /(?:^|\D)([1-4])\s*[x×枚張]/i,
    /[x×]\s*([1-4])(?:\D|$)/i,
    /(?:^|\D)([1-4])\s*(?:張|枚|copies|copy)(?:\D|$)/i,
    /^\s*([1-4])\s+/,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) return Number(match[1]);
  }
  return 1;
}

function looksLikeCardImage(src, alt = "") {
  const value = `${src} ${alt}`.toLowerCase();
  if (!src) return false;
  if (/\.(png|jpe?g|webp)(\?|#|$)/i.test(src) && /(card|ua|union|arena|bt|st|ex|ue|up|img)/i.test(value)) return true;
  if (/\.(png|jpe?g|webp)(\?|#|$)/i.test(src) && !/(logo|icon|banner|twitter|facebook|instagram|youtube|language|global|menu|close)/i.test(value)) return true;
  return false;
}

function extractCardsFromHtml(text, baseUrl) {
  const doc = new DOMParser().parseFromString(text, "text/html");
  const seen = new Set();
  const cards = [];

  doc.querySelectorAll("img").forEach((img) => {
    const rawSrc = img.getAttribute("src") || img.getAttribute("data-src") || img.getAttribute("data-original") || "";
    const alt = img.getAttribute("alt") || img.getAttribute("title") || img.closest("[title]")?.getAttribute("title") || "";
    if (!looksLikeCardImage(rawSrc, alt)) return;
    const parentText = img.closest("li, article, tr, .card, [class*=card], [class*=deck]")?.textContent || img.parentElement?.textContent || "";
    const quantity = parseQuantity(parentText);
    const image = absoluteUrl(rawSrc, baseUrl);
    const key = `${image}|${alt}|${cards.length}`;
    if (seen.has(key)) return;
    seen.add(key);
    cards.push({ name: alt.trim() || image.split("/").pop(), image, quantity });
  });

  return cards;
}

function extractCardsFromText(text, baseUrl) {
  const cards = [];
  const urlPattern = /(https?:\/\/\S+\.(?:png|jpe?g|webp)(?:\?\S*)?|\S+\.(?:png|jpe?g|webp)(?:\?\S*)?)/i;
  text.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const urlMatch = trimmed.match(urlPattern);
    if (!urlMatch) return;
    const quantity = parseQuantity(trimmed);
    const image = absoluteUrl(urlMatch[1], baseUrl);
    const name = trimmed
      .replace(urlMatch[1], "")
      .replace(/^[\s\d x×枚張copycopies.-]+/i, "")
      .trim() || image.split("/").pop();
    cards.push({ name, image, quantity });
  });
  return cards;
}

function restoreRugiaCardId(version, shortId) {
  const cleanVersion = String(version || "").trim();
  const cleanShort = String(shortId || "").trim();
  const candidates = [];
  const packShortMatch = cleanShort.match(/^([A-Z0-9]+)_([0-9])(\d{3})(.*)$/i);
  if (cleanVersion && packShortMatch) {
    candidates.push(`${packShortMatch[1]}_${cleanVersion}-${packShortMatch[2]}-${packShortMatch[3]}${packShortMatch[4]}`);
  }
  if (cleanVersion) {
    if (/^\d{4,}$/.test(cleanShort)) candidates.push(`${cleanVersion}-${cleanShort.slice(0, 1)}-${cleanShort.slice(1)}`);
    candidates.push(`${cleanVersion}${cleanShort}`);
    if (!cleanVersion.endsWith("-") && !cleanShort.startsWith("-")) candidates.push(`${cleanVersion}-${cleanShort}`);
  }
  candidates.push(cleanShort);
  return candidates.find(Boolean);
}

function extractCardsFromRugiaUrl(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/https?:\/\/rugiacreation\.com\/ua\/deck(?:Edit|View)\?[^\s]+/i) || trimmed.match(/\/ua\/deck(?:Edit|View)\?[^\s]+/i);
  if (!match) return [];
  const url = new URL(match[0], "https://rugiacreation.com");
  const version = url.searchParams.get("Version") || url.searchParams.get("version") || "";
  const deck = url.searchParams.get("Deck") || url.searchParams.get("deck") || "";
  if (!version || !deck) return [];

  return deck.split("|").flatMap((part) => {
    const segment = part.trim();
    const hit = segment.match(/^([1-4])(.+)$/);
    if (!hit) return [];
    const quantity = Number(hit[1]);
    const restoredId = restoreRugiaCardId(version, hit[2]);
    const imageId = encodeURIComponent(restoredId).replaceAll("%2F", "/");
    return [{
      name: restoredId,
      image: `https://rugiacreation.com/ua/cardlist/${imageId}.png`,
      quantity,
    }];
  });
}

function importCards(cards, sourceLabel) {
  if (!cards.length) {
    document.querySelector("#importHint").textContent = "沒有解析到卡圖。可以貼 HTML 原始碼，或每行包含圖片網址的牌表。";
    return;
  }

  const total = cards.reduce((sum, card) => sum + Math.max(1, card.quantity || 1), 0);
  commit(`從 ${sourceLabel} 匯入 ${total} 張到牌庫`);
  cards.forEach((entry) => {
    const quantity = Math.max(1, Math.min(4, Number(entry.quantity) || 1));
    for (let i = 0; i < quantity; i += 1) {
      const id = `c-${state.nextId++}`;
      state.cards.set(id, {
        id,
        name: entry.name || `Card ${id}`,
        image: entry.image,
        faceDown: true,
        resting: false,
        stack: [],
        ap: false,
      });
      zones.deck.push(id);
    }
  });
  document.querySelector("#importHint").textContent = `已匯入 ${total} 張。`;
  importDialog.close();
  render();
}

function importFromText() {
  const text = document.querySelector("#importText").value.trim();
  const baseUrl = document.querySelector("#importBaseUrl").value.trim();
  if (!text) return;
  const rugiaCards = extractCardsFromRugiaUrl(text);
  if (rugiaCards.length) {
    importCards(rugiaCards, "路基亞分享連結");
    return;
  }
  const htmlCards = /<\s*(html|body|img|div|li|table|article)\b/i.test(text) ? extractCardsFromHtml(text, baseUrl) : [];
  const textCards = extractCardsFromText(text, baseUrl);
  importCards(htmlCards.length ? htmlCards : textCards, htmlCards.length ? "HTML" : "文字牌表");
}

function createCardElement(card, renderContext = {}) {
  const node = template.content.firstElementChild.cloneNode(true);
  node.draggable = false;
  node.dataset.cardId = card.id;
  node.classList.toggle("face-down", card.faceDown);
  node.classList.toggle("resting", card.resting);
  node.classList.toggle("selected", state.selected.has(card.id));
  node.classList.toggle("has-stack", card.stack.length > 0);
  node.classList.toggle("ap-card", card.ap);
  const img = node.querySelector("img");
  img.draggable = false;
  img.src = card.image || "";
  img.alt = cardName(card);
  if (card.ap && !card.image) {
    node.querySelector(".card-back").textContent = "AP";
  }
  const badge = node.querySelector(".stack-badge");
  badge.textContent = card.stack.length + 1;
  if (renderContext.zone === "life") {
    node.style.setProperty("--life-index", renderContext.index || 0);
  }

  if (renderContext.zone === "front" || renderContext.zone === "energy") {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "field-toggle";
    toggle.title = "橫置/直立";
    toggle.textContent = "↻";
    toggle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleCard(card.id, "resting");
    });
    node.appendChild(toggle);
  }
  if (renderContext.zone === "ap") {
    node.draggable = false;
  }

  function handleDoubleClickAction(event) {
    event.preventDefault();
    closeMenu();
    toggleCard(card.id, "resting");
  }

  function startHandRightDrag(event) {
    if (renderContext.zone !== "hand" || event.button !== 2) return false;
    const handRow = node.closest(".hand-row");
    if (!handRow) return false;
    event.preventDefault();
    event.stopPropagation();
    node.setPointerCapture?.(event.pointerId);
    closeMenu();
    const gesture = {
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      scrollLeft: handRow.scrollLeft,
    };

    function onMove(moveEvent) {
      if (moveEvent.pointerId !== event.pointerId) return;
      const dx = moveEvent.clientX - gesture.startX;
      const dy = moveEvent.clientY - gesture.startY;
      if (!gesture.moved && Math.hypot(dx, dy) > 5) gesture.moved = true;
      if (!gesture.moved) return;
      moveEvent.preventDefault();
      moveEvent.stopPropagation();
      handRow.scrollLeft = gesture.scrollLeft - dx;
    }

    function onUp(upEvent) {
      if (upEvent.pointerId !== event.pointerId) return;
      upEvent.preventDefault();
      upEvent.stopPropagation();
      node.releasePointerCapture?.(event.pointerId);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      suppressHandContextMenuUntil = Date.now() + 450;
      if (gesture.moved) {
        suppressClickBriefly(160);
        return;
      }
      openTwoFingerMenu(card, { clientX: upEvent.clientX, clientY: upEvent.clientY });
    }

    function onCancel(cancelEvent) {
      if (cancelEvent.pointerId !== event.pointerId) return;
      node.releasePointerCapture?.(event.pointerId);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
    }

    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    return true;
  }

  node.addEventListener("pointerdown", (event) => {
    startHandRightDrag(event);
  });

  node.addEventListener("touchstart", (event) => {
    if (renderContext.zone === "ap" || event.target.closest("button")) return;
    if (event.targetTouches.length < 2) return;
    startHandTwoFingerGesture(card, event.targetTouches, node);
    event.preventDefault();
    event.stopPropagation();
  }, { passive: false });

  node.addEventListener("touchmove", (event) => {
    if (updateHandTwoFingerGesture(card, event.targetTouches)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, { passive: false });

  node.addEventListener("touchend", (event) => {
    if (event.targetTouches.length >= 2) return;
    finishHandTwoFingerGesture(card, event);
  }, { passive: false });

  node.addEventListener("touchcancel", () => {
    handTwoFingerGesture = null;
    handTwoFingerScroll = false;
  });

  enablePointerDrag(node, card, renderContext);

  node.addEventListener("dragstart", (event) => {
    if (renderContext.zone === "ap") {
      event.preventDefault();
      return;
    }
    const ids = state.selected.has(card.id) ? [...state.selected] : [card.id];
    event.dataTransfer.setData("text/plain", JSON.stringify(ids));
  });

  node.addEventListener("dragover", (event) => {
    if (renderContext.zone !== "front" && renderContext.zone !== "energy") return;
    event.preventDefault();
    event.stopPropagation();
    node.classList.add("selected");
  });

  node.addEventListener("dragleave", () => {
    if (!state.selected.has(card.id)) node.classList.remove("selected");
  });

  node.addEventListener("drop", (event) => {
    if (renderContext.zone !== "front" && renderContext.zone !== "energy") return;
    event.preventDefault();
    event.stopPropagation();
    const ids = JSON.parse(event.dataTransfer.getData("text/plain") || "[]").filter((id) => id !== card.id);
    if (!ids.length) return;
    raidCardOnto(ids[0], card.id);
  });

  node.addEventListener("click", (event) => {
    event.stopPropagation();
    if (suppressNextClick || Date.now() < suppressClickUntil) {
      event.preventDefault();
      suppressNextClick = false;
      return;
    }
    if (renderContext.zone === "ap") {
      toggleCard(card.id, "resting");
      return;
    }
    if (event.shiftKey || event.ctrlKey) {
      if (state.selected.has(card.id)) state.selected.delete(card.id);
      else state.selected.add(card.id);
      render();
      return;
    }
    if (!card.faceDown) {
      showCard(card);
      return;
    }
    state.contextCardId = card.id;
    openMenu(event.clientX, event.clientY);
  });

  node.addEventListener("dblclick", (event) => {
    handleDoubleClickAction(event);
  });
  node.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    if (renderContext.zone === "ap") return;
    if (renderContext.zone === "hand") {
      return;
    }
    state.contextCardId = card.id;
    openMenu(event.clientX, event.clientY);
  });

  return node;
}

function renderZone(zone) {
  const slot = document.querySelector(`[data-slot="${zone}"]`);
  if (!slot) return;
  slot.innerHTML = "";
  const ids = zone === "deck" ? zones.deck.slice(-1) : zones[zone];
  ids.forEach((id, index) => {
    const card = state.cards.get(id);
    if (card) slot.appendChild(createCardElement(card, { zone, index }));
  });
}

function renderCounts() {
  Object.keys(zones).forEach((zone) => {
    const count = document.querySelector(`[data-count="${zone}"]`);
    if (!count) return;
    const value = zones[zone].length;
    count.textContent = limitedZones.has(zone) ? `${value}/4` : value;
  });
}

function renderLog() {
  const log = document.querySelector("#gameLog");
  if (!log) return;
  log.innerHTML = "";
  state.log.forEach((entry) => {
    const li = document.createElement("li");
    li.textContent = entry;
    log.appendChild(li);
  });
}

function renderTurn() {
  const activePlayer = document.querySelector("#activePlayer");
  const turnPhase = document.querySelector("#turnPhase");
  if (activePlayer) activePlayer.textContent = `玩家 ${state.activePlayer}`;
  if (turnPhase) turnPhase.textContent = phases[state.phaseIndex];
}

function render() {
  Object.keys(zones).forEach(renderZone);
  renderCounts();
  renderLog();
  renderTurn();
}

function openMenu(x, y) {
  const activeDialog = [stackDialog, importDialog].find((item) => item.open);
  if (activeDialog && menu.parentElement !== activeDialog) {
    activeDialog.appendChild(menu);
  } else if (!activeDialog && menu.parentElement !== document.body) {
    document.body.appendChild(menu);
  }
  menu.hidden = false;
  menu.style.left = `${Math.min(x, window.innerWidth - 190)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 360)}px`;
}

function closeMenu() {
  menu.hidden = true;
  if (menu.parentElement !== document.body) {
    document.body.appendChild(menu);
  }
}

function suppressClickBriefly(duration = 180) {
  suppressNextClick = true;
  suppressClickUntil = Date.now() + duration;
  window.setTimeout(() => {
    if (Date.now() >= suppressClickUntil) suppressNextClick = false;
  }, duration);
}

function clearActiveTouchPointer(pointerId) {
  const cardId = activeTouchCards.get(pointerId);
  activeTouchCards.delete(pointerId);
  if (![...activeTouchCards.values()].some((id) => findZone(id) === "hand")) {
    handTwoFingerScroll = false;
    handTwoFingerGesture = null;
  }
  if (twoFingerMenuCardId === cardId && ![...activeTouchCards.values()].includes(cardId)) {
    twoFingerMenuCardId = null;
  }
}

function touchCountForCard(cardId) {
  return [...activeTouchCards.values()].filter((id) => id === cardId).length;
}

function openTwoFingerMenu(card, event) {
  state.contextCardId = card.id;
  state.contextStackEntry = null;
  openMenu(event.clientX, event.clientY);
  suppressClickBriefly(900);
}

function openStackEntryMenu(parentId, index, event) {
  state.contextCardId = null;
  state.contextStackEntry = { parentId, index };
  openMenu(event.clientX, event.clientY);
  suppressClickBriefly(900);
}

function contextStackCard() {
  if (!state.contextStackEntry) return null;
  const parent = state.cards.get(state.contextStackEntry.parentId);
  const entry = parent?.stack[state.contextStackEntry.index];
  return entry ? resolveStackEntry(entry) : null;
}

function touchCenter(touches) {
  const points = [...touches];
  const sum = points.reduce((total, touch) => ({
    x: total.x + touch.clientX,
    y: total.y + touch.clientY,
  }), { x: 0, y: 0 });
  return {
    clientX: sum.x / points.length,
    clientY: sum.y / points.length,
  };
}

function startHandTwoFingerGesture(card, touches, sourceNode = null) {
  const center = touchCenter(touches);
  const handRow = sourceNode?.closest?.(".hand-row") || null;
  handTwoFingerScroll = false;
  handTwoFingerGesture = {
    cardId: card.id,
    zone: findZone(card.id),
    handRow,
    startScrollLeft: handRow?.scrollLeft || 0,
    startX: center.clientX,
    startY: center.clientY,
    lastX: center.clientX,
    lastY: center.clientY,
    moved: false,
    cancelled: Date.now() < touchDragBlockUntil,
  };
  clearPointerDragHighlights();
}

function updateHandTwoFingerGesture(card, touches) {
  if (!handTwoFingerGesture || handTwoFingerGesture.cardId !== card.id || touches.length < 2) return false;
  const center = touchCenter(touches);
  handTwoFingerGesture.lastX = center.clientX;
  handTwoFingerGesture.lastY = center.clientY;
  const dx = center.clientX - handTwoFingerGesture.startX;
  const dy = center.clientY - handTwoFingerGesture.startY;
  if (Math.hypot(dx, dy) > 8) {
    handTwoFingerGesture.moved = true;
    if (handTwoFingerGesture.zone === "hand") {
      handTwoFingerScroll = true;
      if (handTwoFingerGesture.handRow) {
        handTwoFingerGesture.handRow.scrollLeft = handTwoFingerGesture.startScrollLeft - dx;
      }
      return true;
    }
  }
  return handTwoFingerGesture.zone === "hand" && handTwoFingerScroll;
}

function finishHandTwoFingerGesture(card, event) {
  if (!handTwoFingerGesture || handTwoFingerGesture.cardId !== card.id) return;
  const gesture = handTwoFingerGesture;
  handTwoFingerGesture = null;
  handTwoFingerScroll = false;
  if (gesture.moved || gesture.cancelled || Date.now() < touchDragBlockUntil) return;
  event.preventDefault();
  event.stopPropagation();
  openTwoFingerMenu(card, { clientX: gesture.lastX, clientY: gesture.lastY });
}

function clearPointerDragHighlights() {
  document.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
  document.querySelectorAll(".drag-over-card").forEach((el) => el.classList.remove("drag-over-card"));
}

function cardDropTargetAt(x, y, sourceId) {
  const target = document.elementFromPoint(x, y);
  const cardEl = target?.closest?.(".card[data-card-id]");
  if (!cardEl || cardEl.dataset.cardId === sourceId) return null;
  const targetZone = findZone(cardEl.dataset.cardId);
  if (targetZone !== "front" && targetZone !== "energy") return null;
  return cardEl;
}

function zoneDropTargetAt(x, y) {
  const target = document.elementFromPoint(x, y);
  const zoneEl = target?.closest?.("[data-zone]");
  if (!zoneEl || zoneEl.dataset.zone === "ap") return null;
  return zoneEl;
}

function enablePointerDrag(node, card, renderContext) {
  if (renderContext.zone === "ap") return;

  node.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("button")) return;
    if (event.pointerType === "touch") {
      activeTouchCards.set(event.pointerId, card.id);
      if (touchCountForCard(card.id) >= 2) {
        return;
      }
    }

    const ids = state.selected.has(card.id) ? [...state.selected] : [card.id];
    const drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      ids,
      dragging: false,
      pointerType: event.pointerType,
      ghost: null,
      highlight: null,
    };

    function setHighlight(el, className) {
      if (drag.highlight?.el === el && drag.highlight?.className === className) return;
      clearPointerDragHighlights();
      drag.highlight = null;
      if (!el || !className) return;
      el.classList.add(className);
      drag.highlight = { el, className };
    }

    function makeGhost(moveEvent) {
      const rect = node.getBoundingClientRect();
      drag.ghost = node.cloneNode(true);
      drag.ghost.classList.add("drag-ghost");
      drag.ghost.style.width = `${rect.width}px`;
      drag.ghost.style.height = `${rect.height}px`;
      drag.ghost.style.left = `${moveEvent.clientX}px`;
      drag.ghost.style.top = `${moveEvent.clientY}px`;
      document.body.appendChild(drag.ghost);
      closeMenu();
    }

    function onMove(moveEvent) {
      if (moveEvent.pointerId !== drag.pointerId) return;
      if (renderContext.zone === "hand" && (handTwoFingerScroll || handTwoFingerGesture?.cardId === card.id)) return;
      if (twoFingerMenuCardId === card.id) {
        moveEvent.preventDefault();
        return;
      }
      const dx = moveEvent.clientX - drag.startX;
      const dy = moveEvent.clientY - drag.startY;
      if (!drag.dragging && Math.hypot(dx, dy) < 5) return;

      moveEvent.preventDefault();
      if (!drag.dragging) {
        drag.dragging = true;
        if (drag.pointerType === "touch") touchDragBlockUntil = Date.now() + 700;
        makeGhost(moveEvent);
      }
      drag.ghost.style.left = `${moveEvent.clientX}px`;
      drag.ghost.style.top = `${moveEvent.clientY}px`;

      const cardTarget = cardDropTargetAt(moveEvent.clientX, moveEvent.clientY, card.id);
      if (cardTarget) {
        setHighlight(cardTarget, "drag-over-card");
        return;
      }
      const zoneTarget = zoneDropTargetAt(moveEvent.clientX, moveEvent.clientY);
      setHighlight(zoneTarget, zoneTarget ? "drag-over" : null);
    }

    function cleanup() {
      clearPointerDragHighlights();
      drag.ghost?.remove();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    }

    function onCancel(cancelEvent) {
      if (cancelEvent.pointerId !== drag.pointerId) return;
      cleanup();
    }

    function onUp(upEvent) {
      if (upEvent.pointerId !== drag.pointerId) return;
      const wasDragging = drag.dragging;
      cleanup();
      if (!wasDragging) return;

      upEvent.preventDefault();
      suppressClickBriefly(120);
      if (drag.pointerType === "touch") touchDragBlockUntil = Date.now() + 700;

      const cardTarget = cardDropTargetAt(upEvent.clientX, upEvent.clientY, card.id);
      if (cardTarget) {
        const sourceId = drag.ids.find((id) => id !== cardTarget.dataset.cardId);
        if (sourceId) raidCardOnto(sourceId, cardTarget.dataset.cardId);
        return;
      }

      const zoneTarget = zoneDropTargetAt(upEvent.clientX, upEvent.clientY);
      if (zoneTarget) moveCards(drag.ids, zoneTarget.dataset.zone);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  });
}

window.addEventListener("pointerup", (event) => {
  window.setTimeout(() => clearActiveTouchPointer(event.pointerId), 0);
}, { capture: true });
window.addEventListener("pointercancel", (event) => {
  window.setTimeout(() => clearActiveTouchPointer(event.pointerId), 0);
}, { capture: true });

document.addEventListener("touchmove", (event) => {
  if (event.target.closest("dialog") || event.target.closest(".hand-row")) return;
  event.preventDefault();
}, { passive: false, capture: true });

document.addEventListener("wheel", (event) => {
  const handRow = event.target.closest(".hand-row");
  if (handRow) {
    lastHandWheelAt = Date.now();
    if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
      handRow.scrollLeft += event.deltaY;
      event.preventDefault();
    }
    return;
  }
  if (event.target.closest("dialog")) return;
  event.preventDefault();
}, { passive: false, capture: true });

document.addEventListener("click", (event) => {
  if (dialog.open) {
    event.preventDefault();
    event.stopPropagation();
    dialog.close();
    return;
  }
  if (suppressNextClick || Date.now() < suppressClickUntil) {
    event.preventDefault();
    event.stopPropagation();
    suppressNextClick = false;
  }
}, { capture: true });

function lockPageScroll() {
  window.scrollTo(0, 0);
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
}

window.addEventListener("scroll", lockPageScroll, { passive: false });
window.visualViewport?.addEventListener("scroll", lockPageScroll);
window.visualViewport?.addEventListener("resize", fitStageToViewport);

document.querySelectorAll("[data-zone]").forEach((zoneEl) => {
  const zone = zoneEl.dataset.zone;
  if (zone === "sideline" || zone === "removal") {
    zoneEl.addEventListener("click", () => showZoneCards(zone));
  }
  zoneEl.addEventListener("dragover", (event) => {
    if (zone === "ap") return;
    event.preventDefault();
    zoneEl.classList.add("drag-over");
  });
  zoneEl.addEventListener("dragleave", () => zoneEl.classList.remove("drag-over"));
  zoneEl.addEventListener("drop", (event) => {
    if (zone === "ap") return;
    event.preventDefault();
    zoneEl.classList.remove("drag-over");
    const ids = JSON.parse(event.dataTransfer.getData("text/plain") || "[]");
    moveCards(ids, zone);
  });
});

document.querySelectorAll("[data-open-zone]").forEach((button) => {
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    showZoneCards(button.dataset.openZone);
  });
});

document.querySelector("#openTextImport").addEventListener("click", () => importDialog.showModal());
document.querySelector("#closeImportDialog").addEventListener("click", () => importDialog.close());
document.querySelector("#clearImportText").addEventListener("click", () => {
  document.querySelector("#importText").value = "";
  document.querySelector("#importHint").textContent = "支援路基亞 deckEdit 分享連結；HTML 會抓卡圖；文字牌表會抓每行的數量與圖片網址。";
});
document.querySelector("#importFromText").addEventListener("click", importFromText);

document.querySelector(".top-actions").addEventListener("click", (event) => {
  const action = event.target.dataset.action;
  if (!action) return;
  const actions = {
    setupLife,
    openingHand,
    mulligan,
    shuffleDeck,
    drawOne: () => draw(1),
    drawSeven: () => draw(7),
    peekTop,
    revealTop,
    damageOne: () => takeDamage(1),
    damageTwo: () => takeDamage(2),
    readyAll: () => readyZones(true),
  };
  actions[action]?.();
});

menu.addEventListener("click", (event) => {
  const action = event.target.dataset.menu;
  if (!action) return;
  if (state.contextStackEntry) {
    const { parentId, index } = state.contextStackEntry;
    const stacked = contextStackCard();
    const stackActions = {
      view: () => showCard(stacked),
      flip: () => {
        if (!stacked) return;
        commit(`Flip stacked card: ${cardName(stacked)}`);
        stacked.faceDown = !stacked.faceDown;
        showStack(parentId);
      },
      toHand: () => moveStackEntry(parentId, index, "hand"),
      toPublic: () => moveStackEntry(parentId, index, "public"),
      toSideline: () => moveStackEntry(parentId, index, "sideline"),
      toRemoval: () => moveStackEntry(parentId, index, "removal"),
    };
    stackActions[action]?.();
    state.contextStackEntry = null;
    closeMenu();
    return;
  }
  const id = state.contextCardId;
  if (!id) return;
  const actions = {
    view: () => showCard(state.cards.get(id)),
    viewStack: () => showStack(id),
    flip: () => toggleCard(id, "faceDown"),
    rest: () => toggleCard(id, "resting"),
    raid: () => stackOntoSelected(id),
    toHand: () => moveCards([id], "hand"),
    toTop: () => moveCards([id], "deck"),
    toBottom: () => moveCards([id], "deck", { deckPosition: "bottom" }),
    toPublic: () => moveCards([id], "public"),
    toSideline: () => moveCards([id], "sideline"),
    toRemoval: () => moveCards([id], "removal"),
    select: () => {
      if (state.selected.has(id)) state.selected.delete(id);
      else state.selected.add(id);
      render();
    },
  };
  actions[action]?.();
  if (activeZoneDialog && stackDialog.open) {
    showZoneCards(activeZoneDialog);
  }
  closeMenu();
});

function closeMenuAndBlockOutside(event) {
  if (menu.hidden || menu.contains(event.target)) return;
  event.preventDefault();
  event.stopPropagation();
  closeMenu();
}

document.addEventListener("pointerdown", closeMenuAndBlockOutside, { capture: true });
document.addEventListener("click", closeMenuAndBlockOutside, { capture: true });

document.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  event.stopPropagation();
  const handZone = event.target.closest(".hand-zone");
  if (handZone && (Date.now() < suppressHandContextMenuUntil || Date.now() - lastHandWheelAt < 500)) return;
  const stackEl = event.target.closest(".stack-entry-card");
  if (stackEl) {
    openStackEntryMenu(stackEl.dataset.stackParentId, Number(stackEl.dataset.stackIndex), event);
    return;
  }
  const cardEl = event.target.closest(".card[data-card-id]");
  const card = cardEl ? state.cards.get(cardEl.dataset.cardId) : null;
  if (card?.ap) return;
  if (card) openTwoFingerMenu(card, event);
}, { capture: true });

document.addEventListener("gesturestart", (event) => {
  if (!event.target.closest(".hand-zone")) return;
  event.preventDefault();
});

document.querySelector("#undoBtn").addEventListener("click", () => {
  const snap = state.history.pop();
  if (snap) restore(snap);
});

document.querySelector("#layoutModeBtn").addEventListener("click", () => {
  document.body.classList.toggle("layout-mode");
  const enabled = document.body.classList.contains("layout-mode");
  document.querySelector("#layoutModeBtn").classList.toggle("active", enabled);
  document.querySelector("#resetLayoutBtn").hidden = !enabled;
});

document.querySelector("#resetLayoutBtn").addEventListener("click", () => {
  Object.assign(layoutState, defaultLayoutState);
  localStorage.removeItem(layoutStorageKey);
  applyLayout();
});

document.querySelectorAll("[data-resize]").forEach((handle) => {
  handle.addEventListener("pointerdown", (event) => {
    if (!document.body.classList.contains("layout-mode")) return;
    event.preventDefault();
    event.stopPropagation();
    handle.setPointerCapture(event.pointerId);
    const mode = handle.dataset.resize;
    const table = document.querySelector(".table-grid");
    const field = document.querySelector(".field-board");

    function onMove(moveEvent) {
      if (mode === "left-column") {
        const rect = table.getBoundingClientRect();
        layoutState.leftCol = clamp(moveEvent.clientX - rect.left, 150, 380);
      }
      if (mode === "right-column") {
        const rect = table.getBoundingClientRect();
        layoutState.rightCol = clamp(rect.right - moveEvent.clientX, 190, 460);
      }
      if (mode === "front-energy") {
        const rect = field.getBoundingClientRect();
        const total = layoutState.front + layoutState.energy;
        const y = clamp(moveEvent.clientY - rect.top, 50, rect.height - 50);
        const nextFront = clamp((y / rect.height) * total, 0.5, total - 0.5);
        layoutState.energy = total - nextFront;
        layoutState.front = nextFront;
      }
      if (mode === "energy-hand") {
        const rect = table.getBoundingClientRect();
        const total = layoutState.front + layoutState.energy + layoutState.hand;
        const y = clamp(moveEvent.clientY - rect.top, 50, rect.height - 50);
        const frontEnergy = clamp((y / rect.height) * total, layoutState.front + 0.5, total - 0.5);
        layoutState.energy = frontEnergy - layoutState.front;
        layoutState.hand = total - frontEnergy;
      }
      applyLayout();
    }

    function onUp() {
      saveLayout();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
});

document.querySelector("#clearLog")?.addEventListener("click", () => {
  state.log = [];
  renderLog();
});

dialog.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  dialog.close();
});
stackDialog.addEventListener("click", (event) => {
  if (event.target === stackDialog) {
    activeZoneDialog = null;
    stackDialog.close();
  }
});

loadLayout();
applyLayout();
fitStageToViewport();
lockPageScroll();
window.addEventListener("resize", fitStageToViewport);
window.addEventListener("orientationchange", fitStageToViewport);
render();
