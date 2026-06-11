import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { LOCAL_ONLY_FILES, PROFILE_CONFIG_DIR, SHARED_ITEMS } from "./constants";

/**
 * 링크 생성 전략 (D10, D13 — DESIGN.md 참고)
 *
 * 세션 시작 시 한 번 probe 해서 결정한다:
 *
 * 1) **Symlink 모드** — 관리자 권한 또는 Windows 개발자 모드인 경우
 *    - dir / file 모두 `fs.symlink(target, link, 'dir' | 'file')` 로 진짜 symlink 생성
 *    - 제약 없음 (다른 드라이브 OK)
 *
 * 2) **Junction + Hardlink 모드** — 일반 사용자 권한
 *    - dir → `fs.symlink(target, link, 'junction')` (권한 불필요)
 *    - file → `fs.link(target, link)` (하드링크, 권한 불필요)
 *    - 제약: 하드링크는 같은 볼륨(드라이브)에서만 가능
 */

export interface ConflictItem {
	name: string;
	linkPath: string;
	kind: "file" | "dir";
}

export interface ApplyPlan {
	conflicts: ConflictItem[];
	alreadyLinked: string[];
	missingInProfile: string[];
	toCreate: Array<{
		name: string;
		linkPath: string;
		targetPath: string;
		type: "dir" | "file";
		needsCleanup: boolean;
	}>;
}

type LinkStatus =
	| { kind: "missing" }
	| { kind: "linked" }
	| { kind: "wrong-link" }
	| { kind: "conflict"; isDir: boolean };

// ── Symlink 권한 probe (세션 캐시) ─────────────────────────────────────────

let symlinkCapability: boolean | null = null;

/**
 * 현재 프로세스가 진짜 symlink (file 타입) 를 만들 수 있는지 한 번만 확인하고 캐시한다.
 *
 * Windows 에서 file/dir symlink 는 둘 다 같은 권한(SeCreateSymbolicLinkPrivilege)이 필요하므로
 * file symlink 하나만 테스트해도 충분하다. Junction 은 권한 불필요라 별개.
 */
export async function canCreateSymlink(): Promise<boolean> {
	if (symlinkCapability !== null) return symlinkCapability;

	const tmp = os.tmpdir();
	const stamp = `${process.pid}-${Date.now()}`;
	const targetPath = path.join(tmp, `obsidian-sync-settings-probe-target-${stamp}.tmp`);
	const linkPath = path.join(tmp, `obsidian-sync-settings-probe-link-${stamp}.tmp`);

	try {
		await fs.writeFile(targetPath, "");
		await fs.symlink(targetPath, linkPath, "file");
		symlinkCapability = true;
	} catch {
		symlinkCapability = false;
	} finally {
		try {
			await fs.unlink(linkPath);
		} catch {
			/* ignore */
		}
		try {
			await fs.unlink(targetPath);
		} catch {
			/* ignore */
		}
	}

	return symlinkCapability;
}

/**
 * 테스트 등 외부에서 캐시를 강제로 비우거나 설정할 때 사용. 일반 코드에서는 부르지 않음.
 */
export function _resetSymlinkCapability(value: boolean | null = null): void {
	symlinkCapability = value;
}

// ── 항목 상태 검사 ────────────────────────────────────────────────────────

/**
 * vault 안의 한 항목이 프로파일 target 과 어떤 관계인지 검사한다.
 *
 * - dir : symlink 또는 junction → readlink 비교 / 진짜 폴더면 conflict
 * - file: symlink → readlink 비교 / 일반 파일이면 inode 비교(=하드링크) / 그 외 conflict
 */
async function inspectLink(
	linkPath: string,
	targetPath: string,
	type: "dir" | "file",
): Promise<LinkStatus> {
	let lst: import("fs").Stats;
	try {
		lst = await fs.lstat(linkPath);
	} catch {
		return { kind: "missing" };
	}

	if (type === "dir") {
		if (lst.isSymbolicLink()) {
			if (await readlinkMatches(linkPath, targetPath)) return { kind: "linked" };
			return { kind: "wrong-link" };
		}
		return { kind: "conflict", isDir: lst.isDirectory() };
	}

	// type === "file"
	if (lst.isSymbolicLink()) {
		// 두 모드 모두 symlink 가 존재할 수 있다 (관리자 모드 세션 등). target 비교.
		if (await readlinkMatches(linkPath, targetPath)) return { kind: "linked" };
		return { kind: "wrong-link" };
	}

	// 일반 파일 — 하드링크인지 inode 비교
	try {
		const targetStat = await fs.stat(targetPath);
		if (
			lst.ino !== 0 &&
			lst.ino === targetStat.ino &&
			lst.dev === targetStat.dev
		) {
			return { kind: "linked" };
		}
	} catch {
		/* target 없음 — 호출자가 missingInProfile 처리 */
	}
	return { kind: "conflict", isDir: false };
}

/**
 * readlink 결과가 target 과 같은 절대경로인지 비교.
 * Windows junction 의 `\\?\` 프리픽스를 정규화한다.
 */
async function readlinkMatches(linkPath: string, targetPath: string): Promise<boolean> {
	try {
		const current = await fs.readlink(linkPath);
		const cleaned = current.replace(/^\\\\\?\\/, "");
		return path.resolve(cleaned) === path.resolve(targetPath);
	} catch {
		return false;
	}
}

// ── 활성 프로파일 감지 ────────────────────────────────────────────────────

/**
 * 현재 vault 가 어느 프로파일에 연결되어 있는지를 파일시스템에서 직접 감지한다.
 *
 * 진실의 원천: vault `<configDir>/plugins`. symlink/junction 의 target 이
 * `<profilesRoot>/<X>/<PROFILE_CONFIG_DIR>/plugins` 형태면 X 가 활성.
 */
export async function detectActiveProfile(
	vaultPath: string,
	vaultConfigDir: string,
	profilesRoot: string,
): Promise<string | null> {
	if (!profilesRoot) return null;

	const linkPath = path.join(vaultPath, vaultConfigDir, "plugins");

	let lst: import("fs").Stats;
	try {
		lst = await fs.lstat(linkPath);
	} catch {
		return null;
	}
	if (!lst.isSymbolicLink()) return null;

	let target: string;
	try {
		target = await fs.readlink(linkPath);
	} catch {
		return null;
	}

	const cleaned = target.replace(/^\\\\\?\\/, "");
	const resolvedTarget = path.resolve(cleaned);
	const resolvedRoot = path.resolve(profilesRoot);

	const rel = path.relative(resolvedRoot, resolvedTarget);
	if (rel.startsWith("..") || path.isAbsolute(rel)) return null;

	const parts = rel.split(/[\\/]/);
	if (parts.length < 3) return null;
	if (parts[1] !== PROFILE_CONFIG_DIR || parts[2] !== "plugins") return null;

	return parts[0];
}

// ── plan / execute ────────────────────────────────────────────────────────

export async function planApply(
	vaultPath: string,
	vaultConfigDir: string,
	profilesRoot: string,
	profileName: string,
	enabledItems?: Set<string>,
): Promise<ApplyPlan> {
	const profileObsidian = path.join(profilesRoot, profileName, PROFILE_CONFIG_DIR);
	const vaultObsidian = path.join(vaultPath, vaultConfigDir);

	const plan: ApplyPlan = {
		conflicts: [],
		alreadyLinked: [],
		missingInProfile: [],
		toCreate: [],
	};

	const items = enabledItems
		? SHARED_ITEMS.filter((i) => enabledItems.has(i.name))
		: SHARED_ITEMS;

	for (const item of items) {
		const targetPath = path.join(profileObsidian, item.name);
		const linkPath = path.join(vaultObsidian, item.name);

		try {
			await fs.access(targetPath);
		} catch {
			plan.missingInProfile.push(item.name);
			continue;
		}

		const status = await inspectLink(linkPath, targetPath, item.type);

		switch (status.kind) {
			case "missing":
				plan.toCreate.push({
					name: item.name,
					linkPath,
					targetPath,
					type: item.type,
					needsCleanup: false,
				});
				break;

			case "linked":
				plan.alreadyLinked.push(item.name);
				break;

			case "wrong-link":
				plan.toCreate.push({
					name: item.name,
					linkPath,
					targetPath,
					type: item.type,
					needsCleanup: true,
				});
				break;

			case "conflict":
				plan.conflicts.push({
					name: item.name,
					linkPath,
					kind: status.isDir ? "dir" : "file",
				});
				plan.toCreate.push({
					name: item.name,
					linkPath,
					targetPath,
					type: item.type,
					needsCleanup: true,
				});
				break;
		}
	}

	return plan;
}

/**
 * 현재 vault 의 모든 프로파일 링크를 제거하고, 링크가 가리키던 내용을
 * vault 의 독립 복사본으로 교체한다.
 *
 * 반환: 실제로 unlink 처리된 항목 이름 배열.
 */
export async function executeUnlink(vaultPath: string, vaultConfigDir: string): Promise<string[]> {
	const vaultObsidian = path.join(vaultPath, vaultConfigDir);
	const unlinked: string[] = [];

	for (const item of SHARED_ITEMS) {
		const linkPath = path.join(vaultObsidian, item.name);

		let lst: import("fs").Stats;
		try {
			lst = await fs.lstat(linkPath);
		} catch {
			continue; // 항목 자체가 없으면 skip
		}

		if (item.type === "dir") {
			// dir: symlink/junction 인 경우만 처리
			if (!lst.isSymbolicLink()) continue;

			// target 내용을 임시 경로로 복사 → 링크 제거 → 임시를 원래 자리로 이동
			const tmpPath = linkPath + `.unlink-${Date.now()}`;
			await copyDir(linkPath, tmpPath); // linkPath 는 symlink 이므로 follow 해서 내용 복사
			await fs.unlink(linkPath);         // junction/symlink 제거 (target 은 안 건드림)
			await fs.rename(tmpPath, linkPath);
			unlinked.push(item.name);
		} else {
			// file: symlink 이거나 hardlink 인 경우
			const isLink = lst.isSymbolicLink();
			const isHardlink = !isLink && lst.nlink > 1;

			if (!isLink && !isHardlink) continue;

			const content = await fs.readFile(linkPath, "utf8");
			await fs.unlink(linkPath); // symlink 이면 링크 제거, hardlink 이면 이 경로의 참조 제거
			await fs.writeFile(linkPath, content, "utf8");
			unlinked.push(item.name);
		}
	}

	return unlinked;
}

/**
 * 디렉터리를 재귀적으로 복사한다 (symlink follow).
 */
async function copyDir(src: string, dest: string): Promise<void> {
	await fs.mkdir(dest, { recursive: true });
	const entries = await fs.readdir(src, { withFileTypes: true });
	for (const entry of entries) {
		const srcPath = path.join(src, entry.name);
		const destPath = path.join(dest, entry.name);
		if (entry.isDirectory()) {
			await copyDir(srcPath, destPath);
		} else {
			await fs.copyFile(srcPath, destPath);
		}
	}
}

// ── 개별 항목 상태 조회 / link / unlink ──────────────────────────────────

/**
 * 활성 프로파일의 각 SHARED_ITEM 이 실제로 링크되어 있는지 조회한다.
 * 아코디언 토글 초기값 결정에 사용.
 */
export async function getItemLinkStatus(
	vaultPath: string,
	vaultConfigDir: string,
	profilesRoot: string,
	profileName: string,
): Promise<Record<string, boolean>> {
	const profileObsidian = path.join(profilesRoot, profileName, PROFILE_CONFIG_DIR);
	const vaultObsidian = path.join(vaultPath, vaultConfigDir);
	const result: Record<string, boolean> = {};

	for (const item of SHARED_ITEMS) {
		const targetPath = path.join(profileObsidian, item.name);
		const linkPath = path.join(vaultObsidian, item.name);
		const status = await inspectLink(linkPath, targetPath, item.type);
		result[item.name] = status.kind === "linked";
	}
	return result;
}

/**
 * 단일 항목을 프로파일에 링크한다.
 * 기존에 진짜 파일/폴더가 있으면 제거하고 링크를 생성한다.
 */
export async function linkSingleItem(
	vaultPath: string,
	vaultConfigDir: string,
	profilesRoot: string,
	profileName: string,
	itemName: string,
): Promise<void> {
	const item = SHARED_ITEMS.find((i) => i.name === itemName);
	if (!item) throw new Error(`Unknown item: ${itemName}`);

	const profileObsidian = path.join(profilesRoot, profileName, PROFILE_CONFIG_DIR);
	const vaultObsidian = path.join(vaultPath, vaultConfigDir);
	const targetPath = path.join(profileObsidian, item.name);
	const linkPath = path.join(vaultObsidian, item.name);

	try {
		await fs.access(targetPath);
	} catch {
		throw new Error(`"${item.name}" not found in profile.`);
	}

	const status = await inspectLink(linkPath, targetPath, item.type);
	if (status.kind === "linked") return; // 이미 OK

	// 기존 항목 제거
	if (status.kind !== "missing") {
		await fs.rm(linkPath, { recursive: true, force: true });
	}

	await createLink(targetPath, linkPath, item.type);
}

/**
 * 단일 항목의 링크를 제거하고 독립 복사본으로 교체한다.
 * 반환: 실제로 unlink 되었으면 true.
 */
/**
 * 단일 항목의 링크를 제거하고 빈 상태로 초기화한다.
 * - dir: junction 제거 → 빈 폴더 생성
 * - file: 링크 제거 → 기본 내용(initialContent)으로 새 파일 생성
 */
export async function unlinkSingleItem(
	vaultPath: string,
	vaultConfigDir: string,
	itemName: string,
): Promise<boolean> {
	const item = SHARED_ITEMS.find((i) => i.name === itemName);
	if (!item) return false;

	const linkPath = path.join(vaultPath, vaultConfigDir, item.name);

	let lst: import("fs").Stats;
	try {
		lst = await fs.lstat(linkPath);
	} catch {
		return false;
	}

	if (item.type === "dir") {
		if (!lst.isSymbolicLink()) return false;
		await fs.unlink(linkPath); // junction 제거 (target 은 안 건드림)
		await fs.mkdir(linkPath);  // 빈 폴더 생성
		return true;
	}

	// file
	const isLink = lst.isSymbolicLink();
	const isHardlink = !isLink && lst.nlink > 1;
	if (!isLink && !isHardlink) return false;

	await fs.unlink(linkPath);
	await fs.writeFile(linkPath, item.initialContent ?? "{}", "utf8");
	return true;
}

/**
 * 단일 항목의 링크를 끊되 내용은 그대로 보존한다.
 * - dir(junction/symlink): 내용을 temp 로 복사 → 링크 제거 → temp 를 원래 자리로
 * - file(symlink/hardlink): 내용 읽기 → 링크 제거 → 같은 내용으로 새 파일
 *
 * 이전 프로파일의 원본이 현 vault 의 Obsidian 쓰기로 오염되는 것을 막는 용도.
 * 현재 상태가 링크가 아니면 아무 것도 하지 않고 false 를 반환한다.
 */
export async function detachSingleItem(
	vaultPath: string,
	vaultConfigDir: string,
	itemName: string,
): Promise<boolean> {
	const item = SHARED_ITEMS.find((i) => i.name === itemName);
	if (!item) return false;

	const linkPath = path.join(vaultPath, vaultConfigDir, item.name);

	let lst: import("fs").Stats;
	try {
		lst = await fs.lstat(linkPath);
	} catch {
		return false;
	}

	if (item.type === "dir") {
		if (!lst.isSymbolicLink()) return false;
		const tmpPath = linkPath + `.detach-${Date.now()}`;
		await copyDir(linkPath, tmpPath);
		await fs.unlink(linkPath);
		await fs.rename(tmpPath, linkPath);
		return true;
	}

	const isLink = lst.isSymbolicLink();
	const isHardlink = !isLink && lst.nlink > 1;
	if (!isLink && !isHardlink) return false;

	const content = await fs.readFile(linkPath);
	await fs.unlink(linkPath);
	await fs.writeFile(linkPath, content);
	return true;
}

// ── 링크 생성 헬퍼 ──────────────────────────────────────────────────────

async function createLink(
	targetPath: string,
	linkPath: string,
	type: "dir" | "file",
): Promise<void> {
	const useSymlinks = await canCreateSymlink();

	if (useSymlinks) {
		await fs.symlink(targetPath, linkPath, type);
	} else if (type === "dir") {
		await fs.symlink(targetPath, linkPath, "junction");
	} else {
		try {
			await fs.link(targetPath, linkPath);
		} catch (err: unknown) {
			const e = err as NodeJS.ErrnoException;
			if (e.code === "EXDEV") {
				throw new Error(
					`Profile and vault must be on the same drive (${path.basename(linkPath)}).`,
				);
			}
			throw err;
		}
	}
}

// ── plan / execute (전체 적용) ───────────────────────────────────────────

export async function executeApply(vaultPath: string, vaultConfigDir: string, plan: ApplyPlan): Promise<void> {
	const vaultObsidian = path.join(vaultPath, vaultConfigDir);

	await fs.mkdir(vaultObsidian, { recursive: true });

	// 로컬 전용 파일 보존/생성
	for (const localFile of LOCAL_ONLY_FILES) {
		const localPath = path.join(vaultObsidian, localFile);
		try {
			await fs.access(localPath);
		} catch {
			await fs.writeFile(localPath, "{}", "utf8");
		}
	}

	for (const create of plan.toCreate) {
		if (create.needsCleanup) {
			await fs.rm(create.linkPath, { recursive: true, force: true });
		}
		await createLink(create.targetPath, create.linkPath, create.type);
	}
}
