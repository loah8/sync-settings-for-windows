import { promises as fs } from "fs";
import * as path from "path";
import { PROFILE_CONFIG_DIR, SHARED_ITEMS } from "./constants";

/** 허용되는 프로파일 이름: 알파넘 + `_` + `-` + `.` + 공백. 빈 문자열/특수문자 거부. */
const PROFILE_NAME_REGEX = /^[\w\-. ]+$/;

/**
 * 중앙 저장소(profilesRoot) 하위의 폴더명들을 프로파일 목록으로 반환한다.
 * 폴더가 존재하지 않으면 빈 배열을 반환한다.
 */
export async function listProfiles(profilesRoot: string): Promise<string[]> {
	if (!profilesRoot) {
		return [];
	}
	try {
		const entries = await fs.readdir(profilesRoot, { withFileTypes: true });
		return entries
			.filter((e) => e.isDirectory())
			.map((e) => e.name)
			.sort();
	} catch (err: unknown) {
		const e = err as NodeJS.ErrnoException;
		if (e.code === "ENOENT") {
			return [];
		}
		throw err;
	}
}

/**
 * 신규 프로파일을 생성한다.
 *
 * 구조:
 *   <profilesRoot>/<name>/.obsidian/
 *     ├─ plugins/        (빈 폴더)
 *     ├─ themes/         (빈 폴더)
 *     ├─ snippets/       (빈 폴더)
 *     ├─ app.json        ({})
 *     ├─ appearance.json ({})
 *     └─ ...             (SHARED_ITEMS 의 모든 file 항목을 빈 JSON 으로)
 *
 * 이미 존재하는 프로파일이면 에러를 던진다.
 */
export async function createProfile(profilesRoot: string, name: string): Promise<void> {
	validateInputs(profilesRoot, name);

	const profileDir = path.join(profilesRoot, name);
	const obsidianDir = path.join(profileDir, PROFILE_CONFIG_DIR);

	if (await pathExists(profileDir)) {
		throw new Error(`이미 존재하는 프로파일입니다: ${name}`);
	}

	await fs.mkdir(obsidianDir, { recursive: true });

	for (const item of SHARED_ITEMS) {
		const target = path.join(obsidianDir, item.name);
		if (item.type === "dir") {
			await fs.mkdir(target, { recursive: true });
		} else {
			// 파일 — 이미 있으면 덮어쓰지 않음
			if (!(await pathExists(target))) {
				await fs.writeFile(target, item.initialContent ?? "{}", "utf8");
			}
		}
	}
}

/**
 * 프로파일 저장소에 누락된 SHARED_ITEM 을 기본값으로 복구한다.
 *
 * `createProfile` 이 초기 생성 시 모든 항목을 만들지만, 외부 요인(수동 삭제,
 * 이전 버전 플러그인이 만든 저장소 등) 으로 일부 파일이 빠질 수 있다.
 * Activate / Save 직전에 호출해서 저장소 정합성을 보장한다.
 *
 * - dir: 빈 디렉터리 생성
 * - file: `initialContent` (없으면 `{}`) 로 생성
 * - 이미 존재하면 건드리지 않음
 */
export async function healProfile(profilesRoot: string, profileName: string): Promise<void> {
	if (!profilesRoot || !profileName) return;
	const obsidianDir = path.join(profilesRoot, profileName, PROFILE_CONFIG_DIR);
	if (!(await pathExists(obsidianDir))) return;

	for (const item of SHARED_ITEMS) {
		const target = path.join(obsidianDir, item.name);
		if (await pathExists(target)) continue;
		if (item.type === "dir") {
			await fs.mkdir(target, { recursive: true });
		} else {
			await fs.writeFile(target, item.initialContent ?? "{}", "utf8");
		}
	}
}

/**
 * 프로파일을 삭제한다.
 *
 * 안전 장치:
 * - 입력 검증 (이름 형식, 루트 비어있는지)
 * - 삭제 대상 경로가 반드시 profilesRoot 하위인지 검증 (path traversal 방지)
 *
 * 주의: 다른 vault 가 이 프로파일을 가리키는 symlink 를 갖고 있다면 그 링크들은
 * 끊어진 상태로 남는다. 호출자는 사용자에게 이 점을 사전에 안내해야 한다.
 */
export async function deleteProfile(profilesRoot: string, name: string): Promise<void> {
	validateInputs(profilesRoot, name);

	const profileDir = path.join(profilesRoot, name);
	const resolvedRoot = path.resolve(profilesRoot);
	const resolvedTarget = path.resolve(profileDir);

	// path traversal 방지: resolved target 이 반드시 resolved root 의 직접 하위여야 함
	const parent = path.dirname(resolvedTarget);
	if (parent !== resolvedRoot) {
		throw new Error(`잘못된 프로파일 경로입니다: ${profileDir}`);
	}

	if (!(await pathExists(profileDir))) {
		throw new Error(`존재하지 않는 프로파일입니다: ${name}`);
	}

	await fs.rm(profileDir, { recursive: true, force: true });
}

// ─── consumer tracking ────────────────────────────────────────────────────

const CONSUMERS_FILE = "consumers.json";

/**
 * 프로파일의 consumers.json 경로를 반환한다.
 */
function consumersPath(profilesRoot: string, profileName: string): string {
	return path.join(profilesRoot, profileName, CONSUMERS_FILE);
}

/**
 * consumers.json 을 읽어 vault 경로 배열을 반환한다.
 * 파일이 없거나 파싱 실패 시 빈 배열.
 */
async function readConsumers(profilesRoot: string, profileName: string): Promise<string[]> {
	try {
		const raw = await fs.readFile(consumersPath(profilesRoot, profileName), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((x): x is string => typeof x === "string");
	} catch {
		return [];
	}
}

/**
 * consumers.json 에 vault 경로 배열을 저장한다.
 */
async function writeConsumers(profilesRoot: string, profileName: string, consumers: string[]): Promise<void> {
	await fs.writeFile(
		consumersPath(profilesRoot, profileName),
		JSON.stringify(consumers, null, 2),
		"utf8",
	);
}

/**
 * 프로파일에 vault 를 consumer 로 등록한다.
 * 이미 등록되어 있으면 무시.
 */
export async function addConsumer(profilesRoot: string, profileName: string, vaultPath: string): Promise<void> {
	const resolved = path.resolve(vaultPath);
	const consumers = await readConsumers(profilesRoot, profileName);
	if (consumers.some((c) => path.resolve(c) === resolved)) return;
	consumers.push(resolved);
	await writeConsumers(profilesRoot, profileName, consumers);
}

/**
 * 프로파일에서 vault 를 consumer 에서 제거한다.
 */
export async function removeConsumer(profilesRoot: string, profileName: string, vaultPath: string): Promise<void> {
	const resolved = path.resolve(vaultPath);
	const consumers = await readConsumers(profilesRoot, profileName);
	const filtered = consumers.filter((c) => path.resolve(c) !== resolved);
	await writeConsumers(profilesRoot, profileName, filtered);
}

/**
 * 프로파일의 consumer 목록을 반환한다.
 * 존재하지 않는 경로는 자동으로 정리(제거)하고 결과에서도 제외한다.
 */
export async function getConsumers(profilesRoot: string, profileName: string): Promise<string[]> {
	const consumers = await readConsumers(profilesRoot, profileName);
	const alive: string[] = [];
	for (const c of consumers) {
		if (await pathExists(c)) {
			alive.push(c);
		}
	}
	// stale 엔트리가 있었으면 파일 갱신
	if (alive.length !== consumers.length) {
		await writeConsumers(profilesRoot, profileName, alive);
	}
	return alive;
}

// ─── helpers ───────────────────────────────────────────────────────────────

function validateInputs(profilesRoot: string, name: string): void {
	if (!profilesRoot) {
		throw new Error("프로파일 루트 폴더가 지정되지 않았습니다.");
	}
	if (!name || !PROFILE_NAME_REGEX.test(name)) {
		throw new Error("프로파일 이름이 비어있거나 허용되지 않는 문자를 포함합니다.");
	}
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}
