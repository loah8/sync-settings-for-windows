/**
 * .obsidian 하위 항목 중 프로파일로 공유할 대상.
 *
 * - type: 폴더는 'dir' (junction), 파일은 'file' (hardlink)
 * - initialContent: 신규 프로파일 생성 시 비어있는 파일의 초기 내용.
 *   대부분의 Obsidian 설정 파일은 JSON object (`{}`) 지만, 일부는 array (`[]`).
 *   잘못된 형식으로 초기화하면 Obsidian 이 파일을 무시하거나 덮어쓰지 못한다.
 * - hidden: true 이면 UI 토글에 표시하지 않음. group 의 대표 항목이 대신 제어.
 * - group: 같은 group 의 항목은 하나의 토글로 함께 제어된다.
 *   group 내에서 displayName 이 있는 항목이 UI 에 표시되는 대표.
 */
export interface SharedItem {
	name: string;
	type: "dir" | "file";
	displayName?: string;
	initialContent?: string;
	group?: string;
}

export const SHARED_ITEMS: ReadonlyArray<SharedItem> = [
	// ── Community Plugins 그룹: 플러그인 코드 + 활성화 목록 ──
	{ name: "plugins", type: "dir", group: "community-plugins" },
	{ name: "community-plugins.json", type: "file", displayName: "Community Plugins", group: "community-plugins", initialContent: "[]" },

	// ── Appearance 그룹: 테마 파일 + 외형 설정 ──
	{ name: "themes", type: "dir", group: "appearance" },
	{ name: "appearance.json", type: "file", displayName: "Appearance", group: "appearance", initialContent: "{}" },

	// ── 단독 항목 ──
	{ name: "snippets", type: "dir", displayName: "CSS Snippets" },
	{ name: "app.json", type: "file", displayName: "Editor & Files", initialContent: "{}" },
	{ name: "hotkeys.json", type: "file", displayName: "Hotkeys", initialContent: "{}" },
	{ name: "core-plugins.json", type: "file", displayName: "Core plugins", initialContent: "{}" },
];

/**
 * UI 에 표시할 항목만 필터 (displayName 이 있는 항목).
 */
export function getDisplayItems(): ReadonlyArray<SharedItem> {
	return SHARED_ITEMS.filter((i) => i.displayName);
}

/**
 * 특정 항목과 같은 group 에 속하는 모든 항목 이름을 반환.
 * group 이 없으면 자기 자신만 반환.
 */
export function getGroupMembers(itemName: string): string[] {
	const item = SHARED_ITEMS.find((i) => i.name === itemName);
	if (!item?.group) return [itemName];
	return SHARED_ITEMS.filter((i) => i.group === item.group).map((i) => i.name);
}

/**
 * displayName 기준으로 해당 그룹의 모든 항목 이름을 반환.
 */
export function getGroupMembersByDisplay(displayItem: SharedItem): string[] {
	if (!displayItem.group) return [displayItem.name];
	return SHARED_ITEMS.filter((i) => i.group === displayItem.group).map(
		(i) => i.name,
	);
}

/**
 * 각 vault 별로 로컬에 유지해야 하는 파일들 (link 금지, vault 마다 고유).
 * 신규 vault 에 프로파일 적용 시 비어있으면 빈 JSON 파일로 생성.
 */
export const LOCAL_ONLY_FILES: ReadonlyArray<string> = [
	"workspace.json",
	"workspace-mobile.json",
	"graph.json",
];
