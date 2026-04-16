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
	SHARED_ITEMS,
} from "./src/constants";
import { addConsumer, createProfile, deleteProfile, getConsumers, listProfiles, removeConsumer } from "./src/profileManager";
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
): Promise<{ title: string; rows: DetailRow[]; empty: string }> {
	const fs = require("fs").promises;
	const path = require("path");

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
				rows.push({
					label: manifest?.name ?? e.name,
					sub: manifest?.version ? `v${manifest.version}` : e.name,
					enabled: enabledSet.has(e.name),
				});
			}
		} catch {
			/* ignore */
		}
		rows.sort((a, b) => a.label.localeCompare(b.label));
		return { title: "Community Plugins", rows, empty: "No plugins installed." };
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
		return { title: "Appearance — Themes", rows, empty: "No themes found." };
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
		return { title: "CSS Snippets", rows, empty: "No snippets." };
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
	return { title: "Core Plugins — Enabled", rows, empty: "None enabled." };
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
				const active = await detectActiveProfile(vaultPath, profilesRoot);
				if (active) {
					await addConsumer(profilesRoot, active, vaultPath);
				}
			} catch {
				/* ignore — 설정 탭 열기 전이라 조용히 실패 */
			}
		}

		console.log("[profile-settings] loaded");
	}

	onunload() {
		console.log("[profile-settings] unloaded");
	}

	/**
	 * `profilesRoot` 는 junction 바깥(`<vault>/.obsidian/sync-settings.local.json`)에
	 * 별도 저장한다. 프로파일을 전환해도 vault 고유 값으로 유지되어야 하기 때문.
	 * `syncItems` 는 프로파일별 값이라 기존 data.json(프로파일 내부) 에 남긴다.
	 */
	private getLocalSettingsPath(): string | null {
		const vaultPath = this.getVaultPath();
		if (!vaultPath) return null;
		const path = require("path");
		return path.join(vaultPath, ".obsidian", "sync-settings.local.json");
	}

	async loadSettings() {
		const fromData = (await this.loadData()) ?? {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, fromData);
		if (!this.settings.syncItems) this.settings.syncItems = {};

		// vault-local 저장소에서 profilesRoot 를 덮어쓴다.
		const localPath = this.getLocalSettingsPath();
		if (localPath) {
			try {
				const fs = require("fs").promises;
				const raw = await fs.readFile(localPath, "utf8");
				const local = JSON.parse(raw);
				if (typeof local?.profilesRoot === "string") {
					this.settings.profilesRoot = local.profilesRoot;
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
				const fs = require("fs").promises;
				await fs.writeFile(
					localPath,
					JSON.stringify({ profilesRoot: this.settings.profilesRoot }, null, 2),
					"utf8",
				);
			} catch (err) {
				console.error("[profile-settings] failed to write local settings", err);
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
			const fs = require("fs");
			const fd = fs.openSync("\\\\.\\PHYSICALDRIVE0", "r");
			fs.closeSync(fd);
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
	private expandedProfileHints: Record<string, string> = {};
	/** 현재 펼쳐진 프로파일의 토글 초기 스냅샷 (Save dirty 판별용) */
	private toggleBaseline: Record<string, boolean> = {};
	private toggleBaselineProfile: string | null = null;

	constructor(app: App, plugin: ProfileSettingsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	async display(): Promise<void> {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Sync Settings for Windows" });

		if (!this.plugin.isElevated()) {
			const note = containerEl.createEl("p", {
				cls: "profile-settings-admin-note",
			});
			note.createEl("strong", { text: "Note: Obsidian is not running as Administrator." });
			note.createEl("br");
			note.createSpan({
				text: "Only vaults on the same drive as the profiles folder can be linked to a profile.",
			});
		}

		// Profiles folder
		const defaultProfilesRoot = this.plugin.getDefaultProfilesRoot();
		const profilesFolderSetting = new Setting(containerEl)
			.setName("Profiles folder")
			.setDesc("Folder where your shared profiles are stored.")
			.addText((text) =>
				text
					.setPlaceholder(defaultProfilesRoot)
					.setValue(this.plugin.settings.profilesRoot)
					.onChange(async (value) => {
						this.plugin.settings.profilesRoot = value.trim();
						await this.plugin.saveSettings();
					}),
			)
			.addExtraButton((btn) =>
				btn
					.setIcon("save")
					.setTooltip("Save & refresh")
					.onClick(async () => {
						await this.refreshProfiles();
						this.display();
					}),
			);
		profilesFolderSetting.settingEl.addClass("profile-settings-folder-row");

		await this.refreshProfiles();
		await this.detectActive();

		// Profiles section header
		new Setting(containerEl)
			.setName("Profiles")
			.setHeading()
			.addButton((btn) =>
				btn
					.setIcon("plus")
					.setTooltip("New profile")
					.setCta()
					.onClick(() => this.openCreateModal()),
			);

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

	private renderProfileRow(containerEl: HTMLElement, name: string): void {
		const isActive = name === this.activeProfile;
		const isExpanded = name === this.expandedProfile;

		const setting = new Setting(containerEl).setName(name);
		setting.settingEl.addClass("profile-settings-row");

		if (isActive) {
			setting.settingEl.addClass("profile-settings-row-active");
			setting.descEl.empty();
			setting.descEl.createSpan({
				text: "ACTIVATED",
				cls: "profile-settings-active-badge",
			});
		}

		// 이름 영역 클릭 → 아코디언 펼침/접힘
		setting.nameEl.addClass("profile-settings-row-name");
		setting.nameEl.addEventListener("click", () => {
			this.expandedProfile = isExpanded ? null : name;
			this.display();
		});

		const arrow = setting.nameEl.createSpan({
			cls: "profile-settings-chevron",
		});
		setIcon(arrow, isExpanded ? "chevron-up" : "chevron-down");

		// 행 액션 버튼
		if (isActive) {
			setting.addButton((btn) => {
				btn.setButtonText("Deactivate").setWarning();
				const iconSpan = document.createElement("span");
				iconSpan.addClass("profile-settings-btn-icon");
				setIcon(iconSpan, "unlink");
				btn.buttonEl.prepend(iconSpan);
				btn.onClick(() => this.openUnlinkModal());
			});
		} else {
			setting.addButton((btn) => {
				btn.setButtonText("Activate").setCta();
				const iconSpan = document.createElement("span");
				iconSpan.addClass("profile-settings-btn-icon");
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
			cls: "profile-settings-accordion",
		});

		// Options 헤더: 왼쪽 "Options", 오른쪽 "Sync" 라벨 + Save 아이콘
		const header = new Setting(accordion);
		header.settingEl.addClass("profile-settings-options-header");
		header.nameEl.setText("Options");

		// "Sync" 라벨을 control 영역에 추가
		header.controlEl.createSpan({
			text: "Sync",
			cls: "profile-settings-sync-label",
		});

		const dirty = this.hasPendingChanges(name);
		header.addExtraButton((btn) => {
			btn
				.setIcon("save")
				.setTooltip("Save changes")
				.onClick(() => this.applyItemChanges(name));
			if (!dirty) {
				btn.extraSettingsEl.addClass("profile-settings-save-disabled");
			}
		});

		const itemsContainer = accordion.createDiv({
			cls: "profile-settings-items-container",
		});

		for (const displayItem of getDisplayItems()) {
			const itemSetting = new Setting(itemsContainer).setName(
				displayItem.displayName!,
			);
			itemSetting.settingEl.addClass("profile-settings-item-row");

			const hint = this.expandedProfileHints[displayItem.name];
			if (hint) {
				itemSetting.nameEl.createSpan({
					text: `(${hint})`,
					cls: "profile-settings-theme-hint",
				});
			}

			const detailKind = getDetailKind(displayItem.name);
			if (detailKind) {
				itemSetting.addExtraButton((btn) =>
					btn
						.setIcon("info")
						.setTooltip("Details")
						.onClick(() => this.openDetailModal(name, detailKind)),
				);
			}

			const enabled = isGroupEnabled(
				this.plugin.settings,
				name,
				displayItem.name,
			);

			itemSetting.addToggle((toggle) =>
				toggle.setValue(enabled).onChange(async (value) => {
					await this.setItemEnabled(name, displayItem.name, value);
					this.display();
				}),
			);
		}
	}

	// ── Helpers ──

	private async readProfileHints(
		profileName: string,
	): Promise<Record<string, string>> {
		const root = this.plugin.settings.profilesRoot;
		const hints: Record<string, string> = {};
		if (!root) return hints;

		const fs = require("fs").promises;
		const path = require("path");
		const profileObsidian = path.join(root, profileName, ".obsidian");

		const readJson = async (p: string): Promise<unknown> => {
			try {
				return JSON.parse(await fs.readFile(p, "utf8"));
			} catch {
				return null;
			}
		};

		// Community Plugins (enabled / total)
		try {
			const entries = await fs.readdir(path.join(profileObsidian, "plugins"), {
				withFileTypes: true,
			});
			const total = entries.filter((e: any) => e.isDirectory()).length;
			const enabled = (await readJson(
				path.join(profileObsidian, "community-plugins.json"),
			)) as string[] | null;
			const enabledCount = Array.isArray(enabled) ? enabled.length : 0;
			hints["community-plugins.json"] = `${enabledCount}/${total}`;
		} catch {
			/* ignore */
		}

		// Appearance (theme: name)
		const appearance = (await readJson(
			path.join(profileObsidian, "appearance.json"),
		)) as { cssTheme?: string; enabledCssSnippets?: string[] } | null;
		const themeName = (appearance?.cssTheme ?? "").trim() || "Default";
		hints["appearance.json"] = `theme: ${themeName}`;

		// CSS Snippets (enabled / total) — hide when total is 0
		try {
			const entries = await fs.readdir(path.join(profileObsidian, "snippets"), {
				withFileTypes: true,
			});
			const files = entries
				.filter((e: any) => e.isFile() && e.name.endsWith(".css"))
				.map((e: any) => e.name.replace(/\.css$/, ""));
			const enabledList = Array.isArray(appearance?.enabledCssSnippets)
				? appearance!.enabledCssSnippets!
				: [];
			const enabledCount = files.filter((n: string) =>
				enabledList.includes(n),
			).length;
			if (files.length > 0) {
				hints["snippets"] = `${enabledCount}/${files.length}`;
			}
		} catch {
			/* ignore */
		}

		// Core plugins (enabled count) — hide when 0
		const core = (await readJson(
			path.join(profileObsidian, "core-plugins.json"),
		)) as string[] | null;
		const coreCount = Array.isArray(core) ? core.length : 0;
		if (coreCount > 0) {
			hints["core-plugins.json"] = `${coreCount}`;
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
									this.plugin.settings.profilesRoot,
									profileName,
									memberName,
								);
							} else {
								await unlinkSingleItem(vaultPath, memberName);
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
		const path = require("path");
		const profileObsidian = path.join(root, profileName, ".obsidian");
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
		const fs = require("fs").promises;
		const path = require("path");
		try {
			await fs.access(path.join(profilesRoot, name));
		} catch {
			new Notice("This profile no longer exists.", 6000);
			await this.refreshProfiles();
			this.display();
			return;
		}

		const enabledItems = getEnabledItemSet(this.plugin.settings, name);

		// 새 프로파일에서 비활성화된 항목이 이전 프로파일에 링크된 채 남아 있으면
		// 내용을 보존한 상태로 링크를 끊어 이전 프로파일 원본 오염을 방지한다.
		try {
			for (const item of SHARED_ITEMS) {
				if (!enabledItems.has(item.name)) {
					await detachSingleItem(vaultPath, item.name);
				}
			}
		} catch (err) {
			new Notice(`Apply failed: ${(err as Error).message}`, 10000);
			return;
		}

		let plan: ApplyPlan;
		try {
			plan = await planApply(vaultPath, profilesRoot, name, enabledItems);
		} catch (err) {
			new Notice(`Apply failed: ${(err as Error).message}`, 10000);
			return;
		}

		const previousProfile = this.activeProfile;

		const proceed = async () => {
			try {
				await executeApply(vaultPath, plan);
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
		new ConfirmUnlinkModal(this.app, async () => {
			try {
				await executeUnlink(vaultPath);
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
			const resolved = require("path").resolve(vaultPath);
			consumers = consumers.filter((c: string) => require("path").resolve(c) !== resolved);
		}

		if (consumers.length > 0) {
			new ProfileInUseModal(this.app, consumers).open();
			return;
		}

		new ConfirmDeleteProfileModal(this.app, name, async () => {
			try {
				// 현재 vault 에서 활성 중이면 먼저 deactivate
				if (name === this.activeProfile && vaultPath) {
					await executeUnlink(vaultPath);
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

		const wrap = contentEl.createDiv({ cls: "profile-settings-create-wrap" });
		wrap.createEl("label", {
			text: "Profile name",
			cls: "profile-settings-create-label",
		});
		const input = wrap.createEl("input", {
			type: "text",
			cls: "profile-settings-create-input",
		});
		input.placeholder = "default";
		input.addEventListener("input", () => {
			this.name = input.value.trim();
		});
		wrap.createEl("div", {
			text: "Letters, numbers, spaces, and _ - . are allowed.",
			cls: "profile-settings-create-hint",
		});

		const btnRow = contentEl.createDiv({ cls: "modal-button-container" });

		const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());

		const okBtn = btnRow.createEl("button", { text: "Create", cls: "mod-cta" });
		okBtn.addEventListener("click", async () => {
			if (!this.name) {
				new Notice("Please enter a profile name.", 5000);
				return;
			}
			this.close();
			await this.onSubmit(this.name);
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
		this.modalEl.addClass("profile-settings-compact-modal");
		contentEl.createEl("p", {
			text: "Are you sure you want to replace your current settings?",
			cls: "profile-settings-confirm-text",
		});

		const btnRow = contentEl.createDiv({ cls: "modal-button-container" });
		const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());
		const okBtn = btnRow.createEl("button", {
			text: "Activate",
			cls: "mod-cta",
		});
		okBtn.addEventListener("click", async () => {
			this.close();
			await this.onConfirm();
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
		this.modalEl.addClass("profile-settings-compact-modal");
		contentEl.createEl("p", {
			text: "Are you sure you want to deactivate this profile?",
			cls: "profile-settings-confirm-text",
		});

		const btnRow = contentEl.createDiv({ cls: "modal-button-container" });
		const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());
		const okBtn = btnRow.createEl("button", {
			text: "Deactivate",
			cls: "mod-warning",
		});
		okBtn.addEventListener("click", async () => {
			this.close();
			await this.onConfirm();
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

		const { title, rows, empty } = await loadDetails(
			this.profileObsidian,
			this.kind,
		);

		contentEl.createEl("h3", {
			text: title,
			cls: "profile-settings-detail-title",
		});

		if (rows.length === 0) {
			contentEl.createEl("p", {
				text: empty,
				cls: "profile-settings-detail-empty",
			});
			return;
		}

		const list = contentEl.createDiv({ cls: "profile-settings-detail-list" });
		for (const row of rows) {
			const li = list.createDiv({ cls: "profile-settings-detail-row" });
			const left = li.createDiv({ cls: "profile-settings-detail-left" });
			left.createSpan({
				text: row.label,
				cls: "profile-settings-detail-label",
			});
			if (row.sub) {
				left.createSpan({
					text: row.sub,
					cls: "profile-settings-detail-sub",
				});
			}
			if (row.enabled !== undefined) {
				li.createSpan({
					text: row.enabled ? "ON" : "OFF",
					cls: row.enabled
						? "profile-settings-detail-badge profile-settings-detail-on"
						: "profile-settings-detail-badge profile-settings-detail-off",
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
		this.modalEl.addClass("profile-settings-compact-modal");
		contentEl.createEl("p", {
			text: "Reload vault now to apply changes?",
			cls: "profile-settings-confirm-text",
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
				(this.app as any).commands.executeCommandById("app:reload");
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
		this.modalEl.addClass("profile-settings-compact-modal");

		contentEl.createEl("p", {
			text: "This profile is currently in use.",
			cls: "profile-settings-confirm-text",
		});

		const list = contentEl.createEl("ul", { cls: "profile-settings-consumer-list" });
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
		this.modalEl.addClass("profile-settings-compact-modal");

		const msg = contentEl.createEl("p", { cls: "profile-settings-confirm-text" });
		msg.appendText("Are you sure you want to delete ");
		msg.createEl("strong", { text: this.profileName });
		msg.appendText("?");

		const btnRow = contentEl.createDiv({ cls: "modal-button-container" });

		const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());

		const okBtn = btnRow.createEl("button", { text: "Delete", cls: "mod-warning" });
		okBtn.addEventListener("click", async () => {
			this.close();
			await this.onConfirm();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
