(() => {
  const state = {
    mounted: false,
    initialized: false,
    rootId: null,
    rootName: "",
    rootList: true,
    rootCount: 0,
    path: "/",
    parentPath: null,
    items: [],
    mediaItems: [],
    folderItems: [],
    mediaIndexById: new Map(),
    columns: 3,
    gap: 2,
    edge: 6,
    minCell: 110,
    maxColumns: 7,
    cellSize: 0,
    rowHeight: 0,
    rowCount: 0,
    overscan: 3,
    visible: new Map(),
    renderQueued: false,
    initialScrollDone: false,
    selectionMode: false,
    selected: new Set(),
    wakeLock: null,
    uploading: false,
  };

  const elements = {};

  const overlayMap = {};

  const folderIconSvg =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7.5a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';

  const fetchJson = async (url, options = {}) => {
    const response = await fetch(url, {
      cache: "no-store",
      ...options,
    });
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }
    return response.json();
  };

  const updateOverlay = (stateName) => {
    if (!elements.overlay) {
      return;
    }
    elements.overlay.classList.toggle("is-active", Boolean(stateName));
    Object.values(overlayMap).forEach((node) => {
      node?.classList.remove("is-visible");
    });
    if (stateName && overlayMap[stateName]) {
      overlayMap[stateName].classList.add("is-visible");
    }
  };

  const setLoadingText = (text) => {
    if (elements.loadingText) {
      elements.loadingText.textContent = text;
    }
  };

  const syncGridMetrics = () => {
    const styles = getComputedStyle(document.documentElement);
    const gap = parseFloat(styles.getPropertyValue("--grid-gap")) || 2;
    const edge = parseFloat(styles.getPropertyValue("--grid-edge")) || 6;
    const minCell = parseFloat(styles.getPropertyValue("--grid-min")) || 110;
    const maxColumns = Math.max(
      2,
      parseInt(styles.getPropertyValue("--grid-max"), 10) || 7,
    );
    state.gap = gap;
    state.edge = edge;
    state.minCell = minCell;
    state.maxColumns = maxColumns;
  };

  const getMaxScrollTop = () => {
    const scroller = elements.scroller;
    return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  };

  const isNearBottom = () => getMaxScrollTop() - elements.scroller.scrollTop <= 2;

  const scrollToBottom = () => {
    elements.scroller.scrollTop = getMaxScrollTop();
  };

  const updateLayout = () => {
    if (!elements.scroller) {
      return;
    }
    const shouldStickToBottom = !state.initialScrollDone || isNearBottom();
    syncGridMetrics();
    const width = elements.scroller.clientWidth;
    const usable = Math.max(0, width - state.edge * 2);
    const columns = Math.max(
      2,
      Math.floor((usable + state.gap) / (state.minCell + state.gap)),
    );
    state.columns = Math.min(state.maxColumns, columns);
    const cell = Math.floor(
      (usable - state.gap * (state.columns - 1)) / state.columns,
    );
    state.cellSize = Math.max(64, cell);
    state.rowHeight = state.cellSize + state.gap;
    state.rowCount = Math.ceil(state.items.length / state.columns);

    let totalHeight = 0;
    if (state.rowCount > 0) {
      totalHeight = state.rowCount * state.rowHeight - state.gap + state.edge * 2;
    }
    const contentHeight = Math.max(0, totalHeight);
    if (elements.spacer) {
      elements.spacer.style.height = `calc(100vh - 133px)`;
    }
    elements.items.style.height = `${contentHeight}px`;
    if (shouldStickToBottom) {
      scrollToBottom();
    }
    scheduleRender(true);
  };

  const scheduleRender = (force = false) => {
    if (state.renderQueued && !force) {
      return;
    }
    state.renderQueued = true;
    requestAnimationFrame(() => {
      state.renderQueued = false;
      renderVisible();
    });
  };

  const renderVisible = () => {
    if (!elements.scroller) {
      return;
    }
    const scrollTop = elements.scroller.scrollTop;
    const viewportHeight = elements.scroller.clientHeight;
    if (state.rowCount === 0) {
      state.visible.forEach((node) => node.remove());
      state.visible.clear();
      return;
    }

    const startRow = Math.max(
      0,
      Math.floor(scrollTop / state.rowHeight) - state.overscan,
    );
    const endRow = Math.min(
      state.rowCount - 1,
      Math.ceil((scrollTop + viewportHeight) / state.rowHeight) +
        state.overscan,
    );
    const startIndex = startRow * state.columns;
    const endIndex = Math.min(state.items.length, (endRow + 1) * state.columns);

    const nextVisible = new Set();

    for (let index = startIndex; index < endIndex; index += 1) {
      nextVisible.add(index);
      const row = Math.floor(index / state.columns);
      const col = index % state.columns;
      const x = state.edge + col * (state.cellSize + state.gap);
      const y = state.edge + row * (state.cellSize + state.gap);

      let tile = state.visible.get(index);
      if (!tile) {
        tile = createTile(index);
        state.visible.set(index, tile);
        elements.items.appendChild(tile);
      }

      tile.style.width = `${state.cellSize}px`;
      tile.style.height = `${state.cellSize}px`;
      tile.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    }

    for (const [index, node] of state.visible.entries()) {
      if (!nextVisible.has(index)) {
        node.remove();
        state.visible.delete(index);
      }
    }
  };

  const getSelectionKey = (item) => {
    if (item.kind === "folder") {
      return `folder:${item.path}`;
    }
    if (item.kind === "root") {
      return `root:${item.rootId}`;
    }
    return `media:${item.id}`;
  };

  const isSelected = (item) => state.selected.has(getSelectionKey(item));

  const createTile = (index) => {
    const item = state.items[index];
    const button = document.createElement("button");
    button.type = "button";
    button.className = "media-tile";
    button.dataset.index = String(index);

    const select = document.createElement("span");
    select.className = "tile-select";
    button.appendChild(select);

    if (item.kind === "folder" || item.kind === "root") {
      button.classList.add("folder-tile");
      button.setAttribute("aria-label", `文件夹 ${item.name}`);
      const icon = document.createElement("div");
      icon.className = "folder-icon";
      icon.innerHTML = folderIconSvg;
      const label = document.createElement("div");
      label.className = "folder-label";
      label.textContent = item.name;
      button.appendChild(icon);
      button.appendChild(label);
    } else {
      button.setAttribute(
        "aria-label",
        item.mediaType === "video" ? "视频" : "照片",
      );
      const img = document.createElement("img");
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.src = item.thumbUrl;
      img.addEventListener("load", () => {
        img.classList.add("is-loaded");
      });
      button.appendChild(img);

      if (item.mediaType === "video") {
        const badge = document.createElement("span");
        badge.className = "tile-badge";
        badge.innerHTML =
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6l10 6-10 6z"/></svg>视频';
        button.appendChild(badge);
      }
    }

    if (state.selectionMode && isSelected(item)) {
      button.classList.add("is-selected");
    }

    return button;
  };

  const resetTiles = () => {
    state.visible.forEach((node) => node.remove());
    state.visible.clear();
  };

  const updateSelectionUI = () => {
    if (elements.view) {
      elements.view.classList.toggle("is-selecting", state.selectionMode);
    }
    state.visible.forEach((node, index) => {
      const item = state.items[index];
      if (!item) {
        return;
      }
      node.classList.toggle("is-selected", state.selectionMode && isSelected(item));
    });

    if (window.NasPhotoTopbar?.setFolderActionMode) {
      window.NasPhotoTopbar.setFolderActionMode(
        state.selectionMode ? "select" : "default",
        state.selected.size > 0,
      );
    }

    updateTopbarMeta();
  };

  const setSelectionMode = (enabled) => {
    state.selectionMode = enabled;
    state.selected.clear();
    updateSelectionUI();
  };

  const toggleSelection = (item) => {
    const key = getSelectionKey(item);
    if (state.selected.has(key)) {
      state.selected.delete(key);
    } else if (item.kind !== "root") {
      state.selected.add(key);
    }
    updateSelectionUI();
  };

  const updateTopbarMeta = () => {
    if (state.selectionMode) {
      window.NasPhotoTopbar?.setMeta?.(`已选择 ${state.selected.size} 项`);
      return;
    }
    if (state.rootList) {
      window.NasPhotoTopbar?.setMeta?.("选择相册目录");
      return;
    }
    const label =
      state.path === "/"
        ? `根目录 · ${state.rootName || "图库"}`
        : `${state.rootName || "图库"}${state.path}`;
    window.NasPhotoTopbar?.setMeta?.(label);
  };

  const updateNavState = () => {
    if (!elements.backButton) {
      return;
    }
    if (state.rootList) {
      elements.backButton.style.display = "none";
      return;
    }
    elements.backButton.style.display = "";
    if (state.path === "/" && state.rootCount > 1) {
      elements.backButton.textContent = "目录";
    } else {
      elements.backButton.textContent = "上级";
    }
  };

  const openViewerForItem = (item) => {
    const index = state.mediaIndexById.get(item.id);
    if (!Number.isFinite(index)) {
      return;
    }
    window.NasPhotoViewer?.open?.(state.mediaItems, index);
  };

  const handleTileClick = (event) => {
    const target = event.target.closest(".media-tile");
    if (!target) {
      return;
    }
    const index = Number(target.dataset.index);
    if (!Number.isFinite(index)) {
      return;
    }
    const item = state.items[index];
    if (!item) {
      return;
    }
    if (state.selectionMode) {
      toggleSelection(item);
      return;
    }
    if (item.kind === "folder" || item.kind === "root") {
      enterFolder(item);
      return;
    }
    openViewerForItem(item);
  };

  const openSheet = (sheet) => {
    if (!sheet) {
      return;
    }
    sheet.classList.add("is-visible");
    sheet.setAttribute("aria-hidden", "false");
  };

  const closeSheet = (sheet) => {
    if (!sheet) {
      return;
    }
    sheet.classList.remove("is-visible");
    sheet.setAttribute("aria-hidden", "true");
  };

  const closeAllSheets = () => {
    closeSheet(elements.actionSheet);
    closeSheet(elements.createSheet);
    closeSheet(elements.deleteSheet);
  };

  const handleActionSheetClick = (event) => {
    const target = event.target.closest("[data-action]");
    const action = target?.dataset.action;
    if (!action) {
      return;
    }
    if (action === "close") {
      closeSheet(elements.actionSheet);
      return;
    }
    closeSheet(elements.actionSheet);
    if (action === "new") {
      openCreateSheet();
    } else if (action === "upload") {
      elements.uploadInput?.click();
    } else if (action === "select") {
      setSelectionMode(true);
    }
  };

  const openCreateSheet = () => {
    if (!elements.createInput) {
      return;
    }
    elements.createInput.value = "";
    openSheet(elements.createSheet);
    setTimeout(() => {
      elements.createInput?.focus();
    }, 120);
  };

  const requestWakeLock = async () => {
    if (!("wakeLock" in navigator)) {
      return;
    }
    try {
      state.wakeLock = await navigator.wakeLock.request("screen");
    } catch (error) {
      console.warn("Wake lock failed", error);
    }
  };

  const releaseWakeLock = async () => {
    try {
      await state.wakeLock?.release();
    } catch {
      // ignore
    }
    state.wakeLock = null;
  };

  const ensureUniqueSelection = () => {
    state.selected = new Set(
      Array.from(state.selected).filter((key) => {
        if (key.startsWith("media:")) {
          return state.mediaItems.some((item) => `media:${item.id}` === key);
        }
        if (key.startsWith("folder:")) {
          return state.folderItems.some((item) => `folder:${item.path}` === key);
        }
        return false;
      }),
    );
  };

  const enterFolder = (item) => {
    if (item.kind === "root") {
      state.rootId = item.rootId;
      state.rootName = item.name;
      state.path = "/";
      state.rootList = false;
      state.parentPath = null;
    } else {
      state.path = item.path;
      state.rootList = false;
    }
    state.initialScrollDone = false;
    setSelectionMode(false);
    loadFolder();
  };

  const goBack = () => {
    if (state.rootList) {
      return;
    }
    if (state.path === "/" && state.rootCount > 1) {
      state.rootId = null;
      state.rootName = "";
      state.rootList = true;
      state.parentPath = null;
      state.initialScrollDone = false;
      setSelectionMode(false);
      loadFolder();
      return;
    }
    if (!state.parentPath) {
      return;
    }
    state.path = state.parentPath;
    state.initialScrollDone = false;
    setSelectionMode(false);
    loadFolder();
  };

  const loadConfig = async () => {
    try {
      const config = await fetchJson("/api/media/formats");
      const exts = []
        .concat(config.supportedImageExt || [])
        .concat(config.supportedVideoExt || []);
      if (elements.uploadInput) {
        elements.uploadInput.accept = exts.join(",");
      }
    } catch (error) {
      console.warn("Failed to load formats", error);
    }
  };

  const loadFolder = async () => {
    updateOverlay("loading");
    setLoadingText("正在加载目录");
    state.items = [];
    state.mediaItems = [];
    state.folderItems = [];
    state.mediaIndexById.clear();
    resetTiles();
    updateLayout();

    try {
      const query =
        state.rootId === null
          ? ""
          : `?root=${state.rootId}&path=${encodeURIComponent(state.path)}`;
      const data = await fetchJson(`/api/folders${query}`);

      state.rootCount = Number(data.rootCount) || 0;
      state.rootList = Boolean(data.rootList);
      if (Number.isFinite(data.rootId)) {
        state.rootId = data.rootId;
      } else if (state.rootList) {
        state.rootId = null;
      }
      if (data.rootName) {
        state.rootName = data.rootName;
      }
      if (data.path) {
        state.path = data.path;
      }
      state.parentPath = data.parentPath || null;

      if (state.rootList) {
        state.folderItems = (data.folders || []).map((folder) => ({
          kind: "root",
          name: folder.name,
          rootId: folder.rootId,
          path: "/",
        }));
        state.items = [...state.folderItems];
      } else {
        state.folderItems = (data.folders || []).map((folder) => ({
          kind: "folder",
          name: folder.name,
          path: folder.path,
        }));
        state.mediaItems = (data.items || []).map((item) => ({
          kind: "media",
          id: item.id,
          mediaType: item.mediaType,
          timeMs: item.timeMs,
          thumbUrl: item.thumbUrl,
          originalUrl: item.originalUrl,
          relPath: item.relPath,
        }));
        state.mediaItems.forEach((item, index) => {
          state.mediaIndexById.set(item.id, index);
        });
        state.items = [...state.mediaItems, ...state.folderItems];
      }

      ensureUniqueSelection();
      updateSelectionUI();
      updateNavState();
      updateLayout();

      if (state.items.length === 0) {
        updateOverlay("empty");
      } else {
        updateOverlay(null);
      }

      if (elements.actionButton) {
        elements.actionButton.disabled = state.rootId === null;
      }

      if (!state.initialScrollDone) {
        requestAnimationFrame(() => {
          scrollToBottom();
          state.initialScrollDone = true;
        });
      }
    } catch (error) {
      console.error(error);
      updateOverlay("error");
    }
  };

  const createFolder = async (name) => {
    if (!name || !name.trim()) {
      return;
    }
    const trimmed = name.trim();
    if (/[\\/]/.test(trimmed) || trimmed === "." || trimmed === "..") {
      alert("文件夹名称不合法");
      return;
    }
    if (state.rootId === null) {
      return;
    }
    updateOverlay("loading");
    setLoadingText("正在创建文件夹");
    try {
      const payload = {
        rootId: state.rootId,
        path: state.path,
        name: trimmed,
      };
      const data = await fetchJson("/api/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      closeSheet(elements.createSheet);
      if (data?.path) {
        state.path = data.path;
      } else {
        state.path = `${state.path === "/" ? "" : state.path}/${trimmed}`;
      }
      state.rootList = false;
      state.initialScrollDone = false;
      await loadFolder();
    } catch (error) {
      console.error(error);
      updateOverlay("error");
    }
  };

  const uploadFiles = async (files) => {
    if (!files || files.length === 0 || state.rootId === null) {
      return;
    }
    updateOverlay("loading");
    setLoadingText("正在上传文件");
    state.uploading = true;
    await requestWakeLock();
    const formData = new FormData();
    Array.from(files).forEach((file) => {
      formData.append("files", file);
    });
    try {
      const response = await fetch(
        `/api/upload?root=${state.rootId}&path=${encodeURIComponent(state.path)}`,
        {
          method: "POST",
          body: formData,
        },
      );
      if (!response.ok) {
        throw new Error(`Upload failed: ${response.status}`);
      }
      await response.json();
      await loadFolder();
    } catch (error) {
      console.error(error);
      updateOverlay("error");
    } finally {
      state.uploading = false;
      await releaseWakeLock();
      if (elements.uploadInput) {
        elements.uploadInput.value = "";
      }
    }
  };

  const openDeleteConfirm = () => {
    if (state.selected.size === 0) {
      return;
    }
    if (elements.deleteText) {
      elements.deleteText.textContent = `确认删除所选 ${state.selected.size} 项？`;
    }
    openSheet(elements.deleteSheet);
  };

  const animateDeleteSelection = () => {
    state.visible.forEach((node, index) => {
      const item = state.items[index];
      if (item && isSelected(item)) {
        node.classList.add("is-removing");
      }
    });
  };

  const deleteSelected = async () => {
    if (state.selected.size === 0 || state.rootId === null) {
      return;
    }
    animateDeleteSelection();
    await new Promise((resolve) => setTimeout(resolve, 220));
    updateOverlay("loading");
    setLoadingText("正在删除");

    const mediaIds = [];
    const folderPaths = [];
    state.selected.forEach((key) => {
      if (key.startsWith("media:")) {
        mediaIds.push(Number(key.replace("media:", "")));
      } else if (key.startsWith("folder:")) {
        folderPaths.push(key.replace("folder:", ""));
      }
    });

    try {
      await fetchJson("/api/folders/items", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rootId: state.rootId,
          mediaIds,
          folderPaths,
        }),
      });
      closeSheet(elements.deleteSheet);
      setSelectionMode(false);
      await loadFolder();
    } catch (error) {
      console.error(error);
      updateOverlay("error");
    }
  };

  const bindEvents = () => {
    elements.scroller.addEventListener("scroll", () => {
      scheduleRender();
    });
    window.addEventListener("resize", updateLayout);

    elements.items.addEventListener("click", handleTileClick);
    elements.retryButton?.addEventListener("click", loadFolder);
    elements.backButton?.addEventListener("click", goBack);

    elements.actionButton?.addEventListener("click", () => {
      if (elements.actionButton.disabled) {
        return;
      }
      openSheet(elements.actionSheet);
    });
    elements.cancelButton?.addEventListener("click", () => {
      setSelectionMode(false);
    });
    elements.deleteButton?.addEventListener("click", openDeleteConfirm);

    elements.actionSheet?.addEventListener("click", handleActionSheetClick);
    elements.actionSheetBackdrop?.addEventListener("click", () =>
      closeSheet(elements.actionSheet),
    );

    elements.createBackdrop?.addEventListener("click", () =>
      closeSheet(elements.createSheet),
    );
    elements.createCancel?.addEventListener("click", () =>
      closeSheet(elements.createSheet),
    );
    elements.createConfirm?.addEventListener("click", () => {
      createFolder(elements.createInput?.value || "");
    });
    elements.createInput?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        createFolder(elements.createInput?.value || "");
      }
    });

    elements.deleteBackdrop?.addEventListener("click", () =>
      closeSheet(elements.deleteSheet),
    );
    elements.deleteCancel?.addEventListener("click", () =>
      closeSheet(elements.deleteSheet),
    );
    elements.deleteConfirm?.addEventListener("click", deleteSelected);

    elements.uploadInput?.addEventListener("change", (event) => {
      uploadFiles(event.target.files);
    });

    document.addEventListener("visibilitychange", () => {
      if (!state.uploading) {
        return;
      }
      if (document.visibilityState === "visible") {
        requestWakeLock();
      } else {
        releaseWakeLock();
      }
    });
  };

  const mount = async () => {
    if (state.mounted) {
      return;
    }
    const container = document.getElementById("view-folders");
    if (!container) {
      return;
    }
    const response = await fetch("/folders.html", { cache: "no-store" });
    container.innerHTML = await response.text();

    elements.view = document.getElementById("folder-view");
    elements.scroller = document.getElementById("folder-scroller");
    elements.spacer = document.getElementById("folder-spacer");
    elements.items = document.getElementById("folder-items");
    elements.overlay = document.getElementById("folder-overlay");
    elements.loading = document.getElementById("folder-loading");
    elements.loadingText = document.getElementById("folder-loading-text");
    elements.empty = document.getElementById("folder-empty");
    elements.error = document.getElementById("folder-error");
    elements.retryButton = document.getElementById("folder-retry");
    elements.backButton = document.getElementById("folder-back");
    elements.uploadInput = document.getElementById("folder-upload-input");

    elements.actionButton = document.getElementById("folder-action-button");
    elements.cancelButton = document.getElementById("folder-cancel-button");
    elements.deleteButton = document.getElementById("folder-delete-button");

    elements.actionSheet = document.getElementById("folder-action-sheet");
    elements.actionSheetBackdrop =
      elements.actionSheet?.querySelector(".action-sheet-backdrop");
    elements.createSheet = document.getElementById("folder-create-sheet");
    elements.createBackdrop =
      elements.createSheet?.querySelector(".action-sheet-backdrop");
    elements.createInput = document.getElementById("folder-create-input");
    elements.createCancel = document.getElementById("folder-create-cancel");
    elements.createConfirm = document.getElementById("folder-create-confirm");
    elements.deleteSheet = document.getElementById("folder-delete-sheet");
    elements.deleteBackdrop =
      elements.deleteSheet?.querySelector(".action-sheet-backdrop");
    elements.deleteText = document.getElementById("folder-delete-text");
    elements.deleteCancel = document.getElementById("folder-delete-cancel");
    elements.deleteConfirm = document.getElementById("folder-delete-confirm");

    overlayMap.loading = elements.loading;
    overlayMap.empty = elements.empty;
    overlayMap.error = elements.error;

    bindEvents();
    state.mounted = true;
  };

  const activate = async () => {
    await mount();
    if (!state.mounted) {
      return;
    }
    if (!state.initialized) {
      await loadConfig();
      state.initialized = true;
      await loadFolder();
    } else {
      updateNavState();
      updateSelectionUI();
      updateLayout();
    }
    if (elements.actionButton) {
      elements.actionButton.disabled = state.rootId === null;
    }
  };

  window.FolderView = {
    activate,
    refresh: () => loadFolder(),
  };
})();
