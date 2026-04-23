import { closeSync, openSync, promises as fs } from "fs";
import * as path from "path";
import {
	App,
	FileSystemAdapter,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	setIcon,
	Setting,
} from "obsidian";
import {
	getDisplayItems,
	getGroupMembersByDisplay,
	PROFILE_CONFIG_DIR,
	SHARED_ITEMS,
} from "./src/constants";
import { addConsumer, createProfile, deleteProfile, getConsumers, healProfile, listProfiles, removeConsumer } from "./src/profileManager";
import {
	ApplyPlan,
	detachSingleItem,
	detectActiveProfile,
	executeApply,
	executeUnlink,
	getItemLinkStatus,
	linkSingleItem,
	planApply,
	unlinkSingleItem,
} from "./src/symlinkApplier";

// ── Settings ─────────────────────────────────────────────────────────────

interface ProfileSettingsPluginSettings {
	profilesRoot: string;
	/** profileName → { itemName: enabled } — disabled 항목만 false 로 기록 */
	syncItems: Record<string, Record<string, boolean>>;
}

const DEFAULT_SETTINGS: ProfileSettingsPluginSettings = {
	profilesRoot: "",
	syncItems: {},
};

function isItemEnabled(
	settings: ProfileSettingsPluginSettings,
	profileName: string,
	itemName: string,
): boolean {
	return settings.syncItems[profileName]?.[itemName] !== false;
}

/** 그룹 내 모든 멤버가 enabled 인지 (대표 항목 기준) */
function isGroupEnabled(
	settings: ProfileSettingsPluginSettings,
	profileName: string,
	displayItemName: string,
): boolean {
	return isItemEnabled(settings, profileName, displayItemName);
}

function readStringField(raw: unknown, field: string): string | null {
	if (typeof raw !== "object" || raw === null) return null;
	const value = (raw as Record<string, unknown>)[field];
	return typeof value === "string" ? value : null;
}

function getEnabledItemSet(
	settings: ProfileSettingsPluginSettings,
	profileName: string,
): Set<string> {
	const enabled = new Set<string>();
	for (const displayItem of getDisplayItems()) {
		if (isGroupEnabled(settings, profileName, displayItem.name)) {
			for (const memberName of getGroupMembersByDisplay(displayItem)) {
				enabled.add(memberName);
			}
		}
	}
	return enabled;
}

// ── Detail modal types ──────────────────────────────────────────────────

type DetailKind = "community-plugins" | "appearance" | "snippets" | "core-plugins";

/**
 * 아이템 행에 표시할 부가 정보.
 * - subtitleOverride: subtitle 자리를 이 값으로 덮어씀 (accent color). 예: "theme: Obsidianite"
 * - count: 중앙 status 배지용. total 있으면 "X of Y syncing", 없으면 "X syncing"
 */
interface ItemHint {
	subtitleOverride?: string;
	count?: { enabled: number; total?: number };
}

interface DetailRow {
	label: string;
	sub?: string;
	enabled?: boolean;
}

function getDetailKind(displayItemName: string): DetailKind | null {
	switch (displayItemName) {
		case "community-plugins.json":
			return "community-plugins";
		case "appearance.json":
			return "appearance";
		case "snippets":
			return "snippets";
		case "core-plugins.json":
			return "core-plugins";
		default:
			return null;
	}
}

async function loadDetails(
	profileObsidian: string,
	kind: DetailKind,
): Promise<{ title: string; subtitle: string; rows: DetailRow[]; empty: string }> {
	async function readJson(p: string): Promise<unknown> {
		try {
			return JSON.parse(await fs.readFile(p, "utf8"));
		} catch {
			return null;
		}
	}

	if (kind === "community-plugins") {
		const pluginsDir = path.join(profileObsidian, "plugins");
		const enabledRaw = (await readJson(
			path.join(profileObsidian, "community-plugins.json"),
		)) as string[] | null;
		const enabledSet = new Set(Array.isArray(enabledRaw) ? enabledRaw : []);
		const rows: DetailRow[] = [];
		try {
			const entries = await fs.readdir(pluginsDir, { withFileTypes: true });
			for (const e of entries) {
				if (!e.isDirectory()) continue;
				const manifest = (await readJson(
					path.join(pluginsDir, e.name, "manifest.json"),
				)) as { name?: string; version?: string } | null;
				const name = manifest?.name ?? e.name;
				const label = manifest?.version
					? `${name} (v${manifest.version})`
					: name;
				rows.push({
					label,
					enabled: enabledSet.has(e.name),
				});
			}
		} catch {
			/* ignore */
		}
		rows.sort((a, b) => a.label.localeCompare(b.label));
		return {
			title: "Community plugins sync status",
			subtitle: "Plugins included in this profile.",
			rows,
			empty: "No plugins installed.",
		};
	}

	if (kind === "appearance") {
		const appearance = (await readJson(
			path.join(profileObsidian, "appearance.json"),
		)) as { cssTheme?: string } | null;
		const current = (appearance?.cssTheme ?? "").trim();
		const rows: DetailRow[] = [{ label: "Default", enabled: current === "" }];
		try {
			const entries = await fs.readdir(path.join(profileObsidian, "themes"), {
				withFileTypes: true,
			});
			for (const e of entries) {
				if (!e.isDirectory()) continue;
				rows.push({ label: e.name, enabled: e.name === current });
			}
		} catch {
			/* ignore */
		}
		return {
			title: "Appearance sync status",
			subtitle: "Themes included in this profile.",
			rows,
			empty: "No themes found.",
		};
	}

	if (kind === "snippets") {
		const rows: DetailRow[] = [];
		try {
			const entries = await fs.readdir(path.join(profileObsidian, "snippets"), {
				withFileTypes: true,
			});
			for (const e of entries) {
				if (e.isFile() && e.name.endsWith(".css")) {
					rows.push({ label: e.name });
				}
			}
		} catch {
			/* ignore */
		}
		rows.sort((a, b) => a.label.localeCompare(b.label));
		return {
			title: "CSS snippets sync status",
			subtitle: "Snippets included in this profile.",
			rows,
			empty: "No snippets.",
		};
	}

	// core-plugins
	const enabledRaw = (await readJson(
		path.join(profileObsidian, "core-plugins.json"),
	)) as string[] | null;
	const ids = Array.isArray(enabledRaw) ? enabledRaw : [];
	const rows: DetailRow[] = ids
		.slice()
		.sort((a, b) => a.localeCompare(b))
		.map((id) => ({ label: id, enabled: true }));
	return {
		title: "Core plugins sync status",
		subtitle: "Core plugins enabled in this profile.",
		rows,
		empty: "None enabled.",
	};
}

// ── Plugin ───────────────────────────────────────────────────────────────

export default class ProfileSettingsPlugin extends Plugin {
	settings!: ProfileSettingsPluginSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new ProfileSettingsTab(this.app, this));

		// 활성 프로파일이 있으면 consumer 로 자동 등록 (부트스트래핑)
		const vaultPath = this.getVaultPath();
		const { profilesRoot } = this.settings;
		if (vaultPath && profilesRoot) {
			try {
				const active = await detectActiveProfile(vaultPath, this.app.vault.configDir, profilesRoot);
				if (active) {
					await addConsumer(profilesRoot, active, vaultPath);
				}
			} catch {
				/* ignore — 설정 탭 열기 전이라 조용히 실패 */
			}
		}
	}

	onunload() {}

	/**
	 * `profilesRoot` 는 junction 바깥(`<vault>/<configDir>/sync-settings.local.json`)에
	 * 별도 저장한다. 프로파일을 전환해도 vault 고유 값으로 유지되어야 하기 때문.
	 * `syncItems` 는 프로파일별 값이라 기존 data.json(프로파일 내부) 에 남긴다.
	 */
	private getLocalSettingsPath(): string | null {
		const vaultPath = this.getVaultPath();
		if (!vaultPath) return null;
		return path.join(vaultPath, this.app.vault.configDir, "sync-settings.local.json");
	}

	async loadSettings() {
		const fromData = (await this.loadData()) as Partial<ProfileSettingsPluginSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, fromData ?? {});
		if (!this.settings.syncItems) this.settings.syncItems = {};

		// vault-local 저장소에서 profilesRoot 를 덮어쓴다.
		const localPath = this.getLocalSettingsPath();
		if (localPath) {
			try {
				const raw = await fs.readFile(localPath, "utf8");
				const local: unknown = JSON.parse(raw);
				const profilesRoot = readStringField(local, "profilesRoot");
				if (profilesRoot !== null) {
					this.settings.profilesRoot = profilesRoot;
				}
			} catch {
				/* 파일 없음 — 마이그레이션: data.json 에 남아있던 값이 있으면 그대로 사용 */
			}
		}
	}

	async saveSettings() {
		// syncItems 는 data.json 에 저장 (프로파일 내부로 들어가도 OK — 프로파일별 값이라 의도된 동작)
		await this.saveData({ syncItems: this.settings.syncItems });

		// profilesRoot 는 vault-local 파일에 저장 — 프로파일 전환과 무관하게 유지
		const localPath = this.getLocalSettingsPath();
		if (localPath) {
			try {
				await fs.writeFile(
					localPath,
					JSON.stringify({ profilesRoot: this.settings.profilesRoot }, null, 2),
					"utf8",
				);
			} catch (err) {
				console.error("[sync-settings] failed to write local settings", err);
			}
		}
	}

	getDefaultProfilesRoot(): string {
		if (process.platform === "win32") {
			return "C:\\Users\\{userName}\\AppData\\Roaming\\obsidian\\sync-settings";
		}
		if (process.platform === "darwin") {
			return "/Users/{userName}/Library/Application Support/obsidian/sync-settings";
		}
		return "/home/{userName}/.config/obsidian/sync-settings";
	}

	isElevated(): boolean {
		if (process.platform !== "win32") return true;
		try {
			// Opening a raw physical drive handle requires Administrator on Windows.
			const fd = openSync("\\\\.\\PHYSICALDRIVE0", "r");
			closeSync(fd);
			return true;
		} catch {
			return false;
		}
	}

	getVaultPath(): string | null {
		const adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) {
			return adapter.getBasePath();
		}
		return null;
	}
}

// ── Settings Tab ─────────────────────────────────────────────────────────

class ProfileSettingsTab extends PluginSettingTab {
	plugin: ProfileSettingsPlugin;
	private profiles: string[] = [];
	private activeProfile: string | null = null;
	private expandedProfile: string | null = null;
	private activeLinkStatus: Record<string, boolean> = {};
	private expandedProfileHints: Record<string, ItemHint> = {};
	/** 현재 펼쳐진 프로파일의 토글 초기 스냅샷 (Save dirty 판별용) */
	private toggleBaseline: Record<string, boolean> = {};
	private toggleBaselineProfile: string | null = null;

	constructor(app: App, plugin: ProfileSettingsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		this.renderAsync().catch((err) => {
			console.error("[sync-settings] render failed", err);
		});
	}

	private async renderAsync(): Promise<void> {
		const { containerEl } = this;
		containerEl.empty();

		if (!this.plugin.isElevated()) {
			const note = containerEl.createEl("p", {
				cls: "sync-settings-admin-note",
			});
			note.createEl("strong", { text: "Note: Obsidian is not running as administrator." });
			note.createEl("br");
			note.createSpan({
				text: "Only vaults on the same drive as the profiles folder can be linked to a profile.",
			});
		}

		// Profiles folder — custom layout: label / input+save / description
		const defaultProfilesRoot = this.plugin.getDefaultProfilesRoot();
		const folderSection = containerEl.createDiv({
			cls: "sync-settings-folder-section",
		});
		folderSection.createEl("div", {
			text: "Profiles folder",
			cls: "sync-settings-folder-label",
		});
		const folderRow = folderSection.createDiv({
			cls: "sync-settings-folder-row",
		});
		const folderInput = folderRow.createEl("input", {
			type: "text",
			cls: "sync-settings-folder-input",
		});
		folderInput.placeholder = defaultProfilesRoot;
		folderInput.value = this.plugin.settings.profilesRoot;
		folderInput.addEventListener("input", () => {
			void (async () => {
				this.plugin.settings.profilesRoot = folderInput.value.trim();
				await this.plugin.saveSettings();
			})();
		});
		const folderSaveBtn = folderRow.createEl("div", {
			cls: "clickable-icon sync-settings-folder-save",
			attr: {
				"aria-label": "Save & refresh",
				role: "button",
				tabindex: "0",
			},
		});
		setIcon(folderSaveBtn, "save");
		folderSaveBtn.addEventListener("click", () => {
			void (async () => {
				await this.refreshProfiles();
				this.display();
			})();
		});
		folderSection.createEl("div", {
			text: "Folder where your shared profiles are stored.",
			cls: "sync-settings-folder-hint",
		});

		await this.refreshProfiles();
		await this.detectActive();

		// Profiles section header
		const profilesHeading = new Setting(containerEl)
			.setName("Profiles")
			.setHeading()
			.addButton((btn) =>
				btn
					.setIcon("plus")
					.setTooltip("New profile")
					.setCta()
					.onClick(() => this.openCreateModal()),
			);
		profilesHeading.settingEl.addClass("sync-settings-profiles-heading");

		// Empty states
		if (!this.plugin.settings.profilesRoot) {
			containerEl.createEl("p", {
				text: "Set the profiles folder above first.",
				cls: "setting-item-description",
			});
			return;
		}

		if (this.profiles.length === 0) {
			containerEl.createEl("p", {
				text: "No profiles yet. Click + to create one.",
				cls: "setting-item-description",
			});
			return;
		}

		// 활성 프로파일의 실제 링크 상태 조회
		if (this.activeProfile) {
			await this.loadActiveLinkStatus();
			await this.initSyncItemsFromFilesystem(this.activeProfile);
		}

		// 토글 baseline 초기화 (프로파일이 바뀌었거나 처음 펼칠 때)
		if (
			this.expandedProfile &&
			this.toggleBaselineProfile !== this.expandedProfile
		) {
			this.toggleBaselineProfile = this.expandedProfile;
			this.toggleBaseline = {};
			for (const displayItem of getDisplayItems()) {
				this.toggleBaseline[displayItem.name] = isGroupEnabled(
					this.plugin.settings,
					this.expandedProfile,
					displayItem.name,
				);
			}
		}

		if (this.expandedProfile) {
			this.expandedProfileHints = await this.readProfileHints(
				this.expandedProfile,
			);
		} else {
			this.expandedProfileHints = {};
		}

		for (const name of this.profiles) {
			this.renderProfileRow(containerEl, name);
		}
	}

	// ── 프로파일 행 렌더링 ──

	private getSyncingCount(profileName: string): number {
		let count = 0;
		for (const displayItem of getDisplayItems()) {
			if (isGroupEnabled(this.plugin.settings, profileName, displayItem.name)) {
				count++;
			}
		}
		return count;
	}


	private renderProfileRow(containerEl: HTMLElement, name: string): void {
		const isActive = name === this.activeProfile;
		const isExpanded = name === this.expandedProfile;

		const setting = new Setting(containerEl).setName(name);
		setting.settingEl.addClass("sync-settings-row");

		// subtitle: "Active • N items syncing" 또는 "N items syncing"
		setting.descEl.empty();
		const syncingCount = this.getSyncingCount(name);
		const countText = `${syncingCount} ${syncingCount === 1 ? "item" : "items"} syncing`;

		if (isActive) {
			setting.settingEl.addClass("sync-settings-row-active");
			setting.descEl.createSpan({
				text: "Active",
				cls: "sync-settings-active-badge",
			});
			setting.descEl.createSpan({
				text: ` · ${countText}`,
				cls: "sync-settings-row-count",
				attr: { "data-profile": name },
			});
		} else {
			setting.descEl.createSpan({
				text: countText,
				cls: "sync-settings-row-count",
				attr: { "data-profile": name },
			});
		}

		// 이름 영역 클릭 → 아코디언 펼침/접힘
		setting.nameEl.addClass("sync-settings-row-name");
		setting.nameEl.addEventListener("click", () => {
			this.expandedProfile = isExpanded ? null : name;
			this.display();
		});

		const arrow = setting.nameEl.createSpan({
			cls: "sync-settings-chevron",
		});
		setIcon(arrow, isExpanded ? "chevron-up" : "chevron-down");

		// 행 액션 버튼
		if (isActive) {
			setting.addButton((btn) => {
				btn.setButtonText("Deactivate").setWarning();
				const iconSpan = activeDocument.createElement("span");
				iconSpan.addClass("sync-settings-btn-icon");
				setIcon(iconSpan, "unlink");
				btn.buttonEl.prepend(iconSpan);
				btn.onClick(() => this.openUnlinkModal());
			});
		} else {
			setting.addButton((btn) => {
				btn.setButtonText("Activate").setCta();
				const iconSpan = activeDocument.createElement("span");
				iconSpan.addClass("sync-settings-btn-icon");
				setIcon(iconSpan, "link");
				btn.buttonEl.prepend(iconSpan);
				btn.onClick(() => this.handleActivate(name));
			});
		}

		setting.addExtraButton((btn) =>
			btn
				.setIcon("trash-2")
				.setTooltip("Delete")
				.onClick(() => this.openDeleteModal(name)),
		);

		// ── 아코디언 ──
		if (isExpanded) {
			this.renderAccordion(containerEl, name);
		}
	}

	private renderAccordion(containerEl: HTMLElement, name: string): void {
		const accordion = containerEl.createDiv({
			cls: "sync-settings-accordion",
		});

		// 헤더: "SYNC OPTIONS" 라벨 + "SYNC" 컬럼 헤더
		const header = new Setting(accordion);
		header.settingEl.addClass("sync-settings-options-header");
		header.nameEl.setText("Sync options");
		header.controlEl.createSpan({
			text: "Sync",
			cls: "sync-settings-sync-label",
		});

		const itemsContainer = accordion.createDiv({
			cls: "sync-settings-items-container",
		});

		// footer 먼저 생성 (ref 를 closure 로 잡기 위해). DOM 순서는 accordion > items > footer.
		const footer = accordion.createDiv({
			cls: "sync-settings-accordion-footer",
		});
		const statusSpan = footer.createSpan({
			cls: "sync-settings-footer-status",
		});
		const saveBtn = footer.createEl("button", {
			text: "Save",
			cls: "sync-settings-footer-save",
		});
		saveBtn.addEventListener("click", () => {
			if (this.hasPendingChanges(name)) {
				void this.applyItemChanges(name);
			}
		});

		const updateFooter = (): void => {
			const dirty = this.hasPendingChanges(name);
			statusSpan.setText(dirty ? "Changes pending" : "No changes");
			statusSpan.toggleClass("sync-settings-footer-status-dirty", dirty);
			if (dirty) {
				saveBtn.removeAttribute("disabled");
				saveBtn.addClass("mod-cta");
			} else {
				saveBtn.setAttr("disabled", "true");
				saveBtn.removeClass("mod-cta");
			}
		};

		const updateRowCount = (): void => {
			const allCountEls = containerEl.querySelectorAll<HTMLElement>(
				".sync-settings-row-count",
			);
			for (const el of Array.from(allCountEls)) {
				if (el.getAttribute("data-profile") !== name) continue;
				const syncingCount = this.getSyncingCount(name);
				const countText = `${syncingCount} ${syncingCount === 1 ? "item" : "items"} syncing`;
				el.setText(
					name === this.activeProfile ? ` · ${countText}` : countText,
				);
				break;
			}
		};

		updateFooter();

		for (const displayItem of getDisplayItems()) {
			const enabled = isGroupEnabled(
				this.plugin.settings,
				name,
				displayItem.name,
			);
			const hint = this.expandedProfileHints[displayItem.name];

			// subtitle: hint.subtitleOverride 우선, 없으면 displayItem.description
			const subtitle = hint?.subtitleOverride ?? displayItem.description ?? "";

			const itemSetting = new Setting(itemsContainer)
				.setName(displayItem.displayName ?? displayItem.name);
			itemSetting.settingEl.addClass("sync-settings-item-row");
			if (!enabled) {
				itemSetting.settingEl.addClass("sync-settings-item-row-off");
			}
			if (hint?.subtitleOverride) {
				itemSetting.descEl.addClass("sync-settings-subtitle-accent");
			}
			if (subtitle) {
				itemSetting.descEl.setText(subtitle);
			}

			// 중앙 status 배지: detail 가능한 항목 & enabled 이 있거나 total 이 있을 때
			const detailKind = getDetailKind(displayItem.name);
			const hasCount = hint?.count
				&& (hint.count.enabled > 0
					|| (hint.count.total !== undefined && hint.count.total > 0));
			if (detailKind && hint?.count && hasCount) {
				const badgeText = hint.count.total !== undefined
					? `${hint.count.enabled} of ${hint.count.total} syncing`
					: `${hint.count.enabled} syncing`;

				const badge = itemSetting.controlEl.createEl("button", {
					cls: "sync-settings-status-badge",
					attr: { "aria-label": "View details" },
				});
				const eyeIcon = badge.createSpan({ cls: "sync-settings-status-icon" });
				setIcon(eyeIcon, "eye");
				badge.createSpan({ text: badgeText });
				badge.addEventListener("click", () => {
					this.openDetailModal(name, detailKind);
				});
			}

			itemSetting.addToggle((toggle) =>
				toggle.setValue(enabled).onChange(async (value) => {
					await this.setItemEnabled(name, displayItem.name, value);
					itemSetting.settingEl.toggleClass(
						"sync-settings-item-row-off",
						!value,
					);
					updateFooter();
					updateRowCount();
				}),
			);
		}
	}

	// ── Helpers ──

	private async readProfileHints(
		profileName: string,
	): Promise<Record<string, ItemHint>> {
		const root = this.plugin.settings.profilesRoot;
		const hints: Record<string, ItemHint> = {};
		if (!root) return hints;

		const profileObsidian = path.join(root, profileName, PROFILE_CONFIG_DIR);

		const readJson = async (p: string): Promise<unknown> => {
			try {
				return JSON.parse(await fs.readFile(p, "utf8"));
			} catch {
				return null;
			}
		};

		// Community plugins — "enabled of total" 배지
		try {
			const entries = await fs.readdir(path.join(profileObsidian, "plugins"), {
				withFileTypes: true,
			});
			const total = entries.filter((e) => e.isDirectory()).length;
			const enabled = (await readJson(
				path.join(profileObsidian, "community-plugins.json"),
			)) as string[] | null;
			const enabledCount = Array.isArray(enabled) ? enabled.length : 0;
			hints["community-plugins.json"] = { count: { enabled: enabledCount, total } };
		} catch {
			/* ignore */
		}

		// Appearance — themes 폴더 기반 "active of total" 배지 + theme name subtitle
		const appearance = (await readJson(
			path.join(profileObsidian, "appearance.json"),
		)) as { cssTheme?: string; enabledCssSnippets?: string[] } | null;
		const themeName = (appearance?.cssTheme ?? "").trim();
		try {
			const entries = await fs.readdir(path.join(profileObsidian, "themes"), {
				withFileTypes: true,
			});
			const total = entries.filter((e) => e.isDirectory()).length;
			const active = themeName ? 1 : 0;
			if (total > 0 || themeName) {
				hints["appearance.json"] = {
					subtitleOverride: themeName ? `theme: ${themeName}` : undefined,
					count: { enabled: active, total },
				};
			}
		} catch {
			if (themeName) {
				hints["appearance.json"] = {
					subtitleOverride: `theme: ${themeName}`,
				};
			}
		}

		// CSS snippets — "enabled of total" 배지
		try {
			const entries = await fs.readdir(path.join(profileObsidian, "snippets"), {
				withFileTypes: true,
			});
			const files = entries
				.filter((e) => e.isFile() && e.name.endsWith(".css"))
				.map((e) => e.name.replace(/\.css$/, ""));
			const snippets = appearance?.enabledCssSnippets;
			const enabledList = Array.isArray(snippets) ? snippets : [];
			const enabledCount = files.filter((n) =>
				enabledList.includes(n),
			).length;
			if (files.length > 0) {
				hints["snippets"] = { count: { enabled: enabledCount, total: files.length } };
			}
		} catch {
			/* ignore */
		}

		// Core plugins — 총 개수 정보 없음. enabled 만 "N syncing" 형태로
		const core = (await readJson(
			path.join(profileObsidian, "core-plugins.json"),
		)) as string[] | null;
		const coreCount = Array.isArray(core) ? core.length : 0;
		if (coreCount > 0) {
			hints["core-plugins.json"] = { count: { enabled: coreCount } };
		}

		return hints;
	}

	private async refreshProfiles(): Promise<void> {
		try {
			this.profiles = await listProfiles(this.plugin.settings.profilesRoot);
		} catch (err) {
			new Notice(`Failed to read profiles: ${(err as Error).message}`, 8000);
			this.profiles = [];
		}
	}

	private async detectActive(): Promise<void> {
		const vaultPath = this.plugin.getVaultPath();
		if (!vaultPath) {
			this.activeProfile = null;
			return;
		}
		try {
			this.activeProfile = await detectActiveProfile(
				vaultPath,
				this.app.vault.configDir,
				this.plugin.settings.profilesRoot,
			);
		} catch {
			this.activeProfile = null;
		}
	}

	private async loadActiveLinkStatus(): Promise<void> {
		const vaultPath = this.plugin.getVaultPath();
		if (!vaultPath || !this.activeProfile) {
			this.activeLinkStatus = {};
			return;
		}
		try {
			this.activeLinkStatus = await getItemLinkStatus(
				vaultPath,
				this.app.vault.configDir,
				this.plugin.settings.profilesRoot,
				this.activeProfile,
			);
		} catch {
			this.activeLinkStatus = {};
		}
	}

	/**
	 * 활성 프로파일의 syncItems 설정이 아직 없으면,
	 * 파일시스템 상태를 기준으로 초기화한다.
	 * → 토글이 현실과 일치한 상태에서 시작하므로 불필요한 "Apply changes" 가 뜨지 않음.
	 */
	private async initSyncItemsFromFilesystem(profileName: string): Promise<void> {
		if (this.plugin.settings.syncItems[profileName]) return;

		const config: Record<string, boolean> = {};
		let hasDisabled = false;
		for (const displayItem of getDisplayItems()) {
			// 그룹 내 대표 항목의 링크 상태로 판단
			if (!(this.activeLinkStatus[displayItem.name] ?? false)) {
				config[displayItem.name] = false;
				hasDisabled = true;
			}
		}
		if (hasDisabled) {
			this.plugin.settings.syncItems[profileName] = config;
			await this.plugin.saveSettings();
		}
	}

	/** 그룹 단위로 설정 저장. displayItem 의 이름으로 저장한다. */
	private async setItemEnabled(
		profileName: string,
		displayItemName: string,
		enabled: boolean,
	): Promise<void> {
		if (!this.plugin.settings.syncItems[profileName]) {
			this.plugin.settings.syncItems[profileName] = {};
		}
		if (enabled) {
			delete this.plugin.settings.syncItems[profileName][displayItemName];
		} else {
			this.plugin.settings.syncItems[profileName][displayItemName] = false;
		}
		await this.plugin.saveSettings();
	}

	// ── Pending changes (토글 baseline 과 현재 설정 비교) ──

	private hasPendingChanges(profileName: string): boolean {
		if (this.toggleBaselineProfile !== profileName) return false;
		for (const displayItem of getDisplayItems()) {
			const current = isGroupEnabled(
				this.plugin.settings,
				profileName,
				displayItem.name,
			);
			const baseline = this.toggleBaseline[displayItem.name] ?? true;
			if (current !== baseline) return true;
		}
		return false;
	}

	private async applyItemChanges(profileName: string): Promise<void> {
		const vaultPath = this.plugin.getVaultPath();
		if (!vaultPath) return;

		const isActive = profileName === this.activeProfile;

		try {
			if (isActive) {
				// Self-heal: 저장소에 누락된 SHARED_ITEM 을 initialContent 로 복구
				await healProfile(this.plugin.settings.profilesRoot, profileName);

				for (const displayItem of getDisplayItems()) {
					const desired = isGroupEnabled(
						this.plugin.settings,
						profileName,
						displayItem.name,
					);
					const baseline = this.toggleBaseline[displayItem.name] ?? true;

					if (desired !== baseline) {
						// 그룹 내 모든 멤버를 link/unlink
						for (const memberName of getGroupMembersByDisplay(displayItem)) {
							if (desired) {
								await linkSingleItem(
									vaultPath,
									this.app.vault.configDir,
									this.plugin.settings.profilesRoot,
									profileName,
									memberName,
								);
							} else {
								await unlinkSingleItem(vaultPath, this.app.vault.configDir, memberName);
							}
						}
					}
				}
			}
			this.toggleBaselineProfile = null;
			this.display();
			if (isActive) {
				new ConfirmReloadModal(this.app).open();
			}
		} catch (err) {
			new Notice(`Save failed: ${(err as Error).message}`, 8000);
			this.toggleBaselineProfile = null;
			this.display();
		}
	}

	private openDetailModal(profileName: string, kind: DetailKind): void {
		const root = this.plugin.settings.profilesRoot;
		if (!root) return;
		const profileObsidian = path.join(root, profileName, PROFILE_CONFIG_DIR);
		new DetailModal(this.app, profileObsidian, kind).open();
	}

	// ── Create ──
	private openCreateModal(): void {
		if (!this.plugin.settings.profilesRoot) {
			new Notice("Please set the profiles folder first.", 6000);
			return;
		}
		new CreateProfileModal(this.app, async (name) => {
			try {
				await createProfile(this.plugin.settings.profilesRoot, name);
				await this.refreshProfiles();
				this.display();
			} catch (err) {
				new Notice(`Create failed: ${(err as Error).message}`, 8000);
			}
		}).open();
	}

	// ── Apply / Activate ──
	private async handleActivate(name: string): Promise<void> {
		const { profilesRoot } = this.plugin.settings;
		const vaultPath = this.plugin.getVaultPath();
		if (!vaultPath) {
			new Notice("Desktop only. This feature is not available on mobile.", 6000);
			return;
		}

		// 프로파일이 아직 존재하는지 확인 (다른 vault 에서 삭제됐을 수 있음)
		try {
			await fs.access(path.join(profilesRoot, name));
		} catch {
			new Notice("This profile no longer exists.", 6000);
			await this.refreshProfiles();
			this.display();
			return;
		}

		// Self-heal: 저장소에 누락된 SHARED_ITEM 을 initialContent 로 복구
		try {
			await healProfile(profilesRoot, name);
		} catch (err) {
			new Notice(`Apply failed: ${(err as Error).message}`, 10000);
			return;
		}

		const enabledItems = getEnabledItemSet(this.plugin.settings, name);

		// 새 프로파일에서 비활성화된 항목이 이전 프로파일에 링크된 채 남아 있으면
		// 내용을 보존한 상태로 링크를 끊어 이전 프로파일 원본 오염을 방지한다.
		const configDir = this.app.vault.configDir;

		try {
			for (const item of SHARED_ITEMS) {
				if (!enabledItems.has(item.name)) {
					await detachSingleItem(vaultPath, configDir, item.name);
				}
			}
		} catch (err) {
			new Notice(`Apply failed: ${(err as Error).message}`, 10000);
			return;
		}

		let plan: ApplyPlan;
		try {
			plan = await planApply(vaultPath, configDir, profilesRoot, name, enabledItems);
		} catch (err) {
			new Notice(`Apply failed: ${(err as Error).message}`, 10000);
			return;
		}

		const previousProfile = this.activeProfile;

		const proceed = async () => {
			try {
				await executeApply(vaultPath, configDir, plan);
				// consumer 추적: 이전 프로파일에서 제거, 새 프로파일에 등록
				if (previousProfile && previousProfile !== name) {
					await removeConsumer(profilesRoot, previousProfile, vaultPath);
				}
				await addConsumer(profilesRoot, name, vaultPath);
				this.display();
				new ConfirmReloadModal(this.app).open();
			} catch (err) {
				new Notice(`Apply failed: ${(err as Error).message}`, 12000);
			}
		};

		if (plan.conflicts.length > 0) {
			new ConfirmConflictModal(
				this.app,
				name,
				plan.conflicts.map((c) => c.name),
				proceed,
			).open();
		} else {
			new ConfirmConflictModal(this.app, name, [], proceed).open();
		}
	}

	// ── Unlink ──
	private openUnlinkModal(): void {
		const vaultPath = this.plugin.getVaultPath();
		if (!vaultPath) {
			new Notice("Desktop only. This feature is not available on mobile.", 6000);
			return;
		}
		const activeProfile = this.activeProfile;
		const { profilesRoot } = this.plugin.settings;
		const configDir = this.app.vault.configDir;
		new ConfirmUnlinkModal(this.app, async () => {
			try {
				await executeUnlink(vaultPath, configDir);
				if (activeProfile && profilesRoot) {
					await removeConsumer(profilesRoot, activeProfile, vaultPath);
				}
				this.display();
			} catch (err) {
				new Notice(`Unlink failed: ${(err as Error).message}`, 8000);
			}
		}).open();
	}

	// ── Delete ──
	private async openDeleteModal(name: string): Promise<void> {
		const { profilesRoot } = this.plugin.settings;

		// consumer 체크: 다른 vault 가 사용 중이면 차단
		let consumers: string[] = [];
		try {
			consumers = await getConsumers(profilesRoot, name);
		} catch {
			/* consumers.json 읽기 실패 — 빈 배열로 진행 */
		}

		// 현재 vault 자신은 목록에서 제외 (자기 vault 는 deactivate + delete 로 처리)
		const vaultPath = this.plugin.getVaultPath();
		if (vaultPath) {
			const resolved = path.resolve(vaultPath);
			consumers = consumers.filter((c: string) => path.resolve(c) !== resolved);
		}

		if (consumers.length > 0) {
			new ProfileInUseModal(this.app, consumers).open();
			return;
		}

		const configDir = this.app.vault.configDir;
		new ConfirmDeleteProfileModal(this.app, name, async () => {
			try {
				// 현재 vault 에서 활성 중이면 먼저 deactivate
				if (name === this.activeProfile && vaultPath) {
					await executeUnlink(vaultPath, configDir);
					await removeConsumer(profilesRoot, name, vaultPath);
				}
				await deleteProfile(profilesRoot, name);
				delete this.plugin.settings.syncItems[name];
				await this.plugin.saveSettings();
				await this.refreshProfiles();
				this.display();
			} catch (err) {
				new Notice(`Delete failed: ${(err as Error).message}`, 8000);
			}
		}).open();
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Modals
// ═══════════════════════════════════════════════════════════════════════════

class CreateProfileModal extends Modal {
	private onSubmit: (name: string) => void | Promise<void>;
	private name = "";

	constructor(app: App, onSubmit: (name: string) => void | Promise<void>) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		const wrap = contentEl.createDiv({ cls: "sync-settings-create-wrap" });
		wrap.createEl("label", {
			text: "Profile name",
			cls: "sync-settings-create-label",
		});
		const input = wrap.createEl("input", {
			type: "text",
			cls: "sync-settings-create-input",
		});
		input.placeholder = "Default";
		input.addEventListener("input", () => {
			this.name = input.value.trim();
		});
		wrap.createEl("div", {
			text: "Letters, numbers, spaces, underscores, hyphens, and dots are allowed",
			cls: "sync-settings-create-hint",
		});

		const btnRow = contentEl.createDiv({ cls: "modal-button-container" });

		const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());

		const okBtn = btnRow.createEl("button", { text: "Create", cls: "mod-cta" });
		okBtn.addEventListener("click", () => {
			if (!this.name) {
				new Notice("Please enter a profile name.", 5000);
				return;
			}
			this.close();
			void this.onSubmit(this.name);
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class ConfirmConflictModal extends Modal {
	private onConfirm: () => void | Promise<void>;

	constructor(
		app: App,
		_profileName: string,
		_items: string[],
		onConfirm: () => void | Promise<void>,
	) {
		super(app);
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.modalEl.addClass("sync-settings-compact-modal");
		contentEl.createEl("p", {
			text: "Are you sure you want to replace your current settings?",
			cls: "sync-settings-confirm-text",
		});

		const btnRow = contentEl.createDiv({ cls: "modal-button-container" });
		const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());
		const okBtn = btnRow.createEl("button", {
			text: "Activate",
			cls: "mod-cta",
		});
		okBtn.addEventListener("click", () => {
			this.close();
			void this.onConfirm();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class ConfirmUnlinkModal extends Modal {
	private onConfirm: () => void | Promise<void>;

	constructor(app: App, onConfirm: () => void | Promise<void>) {
		super(app);
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.modalEl.addClass("sync-settings-compact-modal");
		contentEl.createEl("p", {
			text: "Are you sure you want to deactivate this profile?",
			cls: "sync-settings-confirm-text",
		});

		const btnRow = contentEl.createDiv({ cls: "modal-button-container" });
		const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());
		const okBtn = btnRow.createEl("button", {
			text: "Deactivate",
			cls: "mod-warning",
		});
		okBtn.addEventListener("click", () => {
			this.close();
			void this.onConfirm();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class DetailModal extends Modal {
	private profileObsidian: string;
	private kind: DetailKind;

	constructor(app: App, profileObsidian: string, kind: DetailKind) {
		super(app);
		this.profileObsidian = profileObsidian;
		this.kind = kind;
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();

		const { title, subtitle, rows, empty } = await loadDetails(
			this.profileObsidian,
			this.kind,
		);

		contentEl.createEl("h3", {
			text: title,
			cls: "sync-settings-detail-title",
		});
		contentEl.createEl("p", {
			text: subtitle,
			cls: "sync-settings-detail-subtitle",
		});

		if (rows.length === 0) {
			contentEl.createEl("p", {
				text: empty,
				cls: "sync-settings-detail-empty",
			});
			return;
		}

		const list = contentEl.createDiv({ cls: "sync-settings-detail-list" });
		for (const row of rows) {
			const li = list.createDiv({ cls: "sync-settings-detail-row" });
			const left = li.createDiv({ cls: "sync-settings-detail-left" });
			left.createSpan({
				text: row.label,
				cls: "sync-settings-detail-label",
			});
			if (row.sub) {
				left.createSpan({
					text: row.sub,
					cls: "sync-settings-detail-sub",
				});
			}
			if (row.enabled !== undefined) {
				li.createSpan({
					text: row.enabled ? "On" : "Off",
					cls: row.enabled
						? "sync-settings-detail-badge sync-settings-detail-on"
						: "sync-settings-detail-badge sync-settings-detail-off",
				});
			}
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class ConfirmReloadModal extends Modal {
	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.modalEl.addClass("sync-settings-compact-modal");
		contentEl.createEl("p", {
			text: "Reload vault now to apply changes?",
			cls: "sync-settings-confirm-text",
		});

		const btnRow = contentEl.createDiv({ cls: "modal-button-container" });
		const laterBtn = btnRow.createEl("button", { text: "Later" });
		laterBtn.addEventListener("click", () => this.close());
		const reloadBtn = btnRow.createEl("button", {
			text: "Reload",
			cls: "mod-cta",
		});
		reloadBtn.addEventListener("click", () => {
			this.close();
			try {
				activeWindow.location.reload();
			} catch {
				new Notice("Could not reload automatically. Please restart Obsidian.", 8000);
			}
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class ProfileInUseModal extends Modal {
	private consumers: string[];

	constructor(app: App, consumers: string[]) {
		super(app);
		this.consumers = consumers;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.modalEl.addClass("sync-settings-compact-modal");

		contentEl.createEl("p", {
			text: "This profile is currently in use.",
			cls: "sync-settings-confirm-text",
		});

		const list = contentEl.createEl("ul", { cls: "sync-settings-consumer-list" });
		for (const c of this.consumers) {
			list.createEl("li", { text: c });
		}

		contentEl.createEl("p", {
			text: "Deactivate it in each vault above, then try again.",
			cls: "setting-item-description",
		});

		const btnRow = contentEl.createDiv({ cls: "modal-button-container" });
		const okBtn = btnRow.createEl("button", { text: "OK", cls: "mod-cta" });
		okBtn.addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class ConfirmDeleteProfileModal extends Modal {
	private profileName: string;
	private onConfirm: () => void | Promise<void>;

	constructor(app: App, profileName: string, onConfirm: () => void | Promise<void>) {
		super(app);
		this.profileName = profileName;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.modalEl.addClass("sync-settings-compact-modal");

		const msg = contentEl.createEl("p", { cls: "sync-settings-confirm-text" });
		msg.appendText("Are you sure you want to delete ");
		msg.createEl("strong", { text: this.profileName });
		msg.appendText("?");

		const btnRow = contentEl.createDiv({ cls: "modal-button-container" });

		const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());

		const okBtn = btnRow.createEl("button", { text: "Delete", cls: "mod-warning" });
		okBtn.addEventListener("click", () => {
			this.close();
			void this.onConfirm();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
