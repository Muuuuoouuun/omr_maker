import {
    AVATAR_COLORS,
    GROUP_COLORS,
    ROSTER_STORAGE_KEYS,
    readRosterGroups,
    readRosterInvites,
    readRosterStudents,
    type RosterGroup,
    type RosterStudent,
} from "@/lib/rosterStorage";
import { readStudentCodes, STUDENT_CODES_STORAGE_KEY } from "@/lib/studentCodes";

type LocalStorageLike = Pick<Storage, "getItem" | "setItem">;

export interface LocalTestAccountSeedOptions {
    enabled?: boolean;
    nodeEnv?: string;
}

export const LOCAL_TEST_STUDENT_ACCOUNTS = [
    { id: "student1", name: "학생 1", email: "student1@example.com", startCode: "ABC234" },
    { id: "student2", name: "학생 2", email: "student2@example.com", startCode: "BCD345" },
    { id: "student3", name: "학생 3", email: "student3@example.com", startCode: "CDE456" },
    { id: "student4", name: "학생 4", email: "student4@example.com", startCode: "DEF567" },
] as const;

export const LOCAL_TEST_STUDENT_GROUP: RosterGroup = {
    id: "local-test-class",
    name: "테스트반",
    region: "서울",
    count: LOCAL_TEST_STUDENT_ACCOUNTS.length,
    avgScore: 0,
    color: GROUP_COLORS[0],
};

function isEnabled(options: LocalTestAccountSeedOptions): boolean {
    const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
    const enabled = options.enabled ?? process.env.NEXT_PUBLIC_OMR_SEED_TEST_ACCOUNTS === "1";
    return nodeEnv !== "production" && enabled;
}

/**
 * Adds the opt-in local test roster without replacing user-created roster rows or
 * rotating an already-issued start code. Production deliberately ignores this seed.
 */
export function seedLocalTestStudentAccounts(
    storage: LocalStorageLike,
    options: LocalTestAccountSeedOptions = {},
): { seeded: boolean; addedStudents: number } {
    if (!isEnabled(options)) return { seeded: false, addedStudents: 0 };

    const students = readRosterStudents(storage);
    const groups = readRosterGroups(storage);
    const invites = readRosterInvites(storage);
    const codes = readStudentCodes(storage);
    const existingIds = new Set(students.map(student => student.id));
    const existingEmails = new Set(students.map(student => student.email.trim().toLowerCase()).filter(Boolean));
    const addedStudents: RosterStudent[] = [];

    for (const [index, account] of LOCAL_TEST_STUDENT_ACCOUNTS.entries()) {
        if (!existingIds.has(account.id) && !existingEmails.has(account.email.toLowerCase())) {
            addedStudents.push({
                id: account.id,
                name: account.name,
                email: account.email,
                group: LOCAL_TEST_STUDENT_GROUP.name,
                region: LOCAL_TEST_STUDENT_GROUP.region,
                avatar: AVATAR_COLORS[index % AVATAR_COLORS.length],
                avgScore: 0,
                examsTaken: 0,
                lastActive: "기록 없음",
                trend: "flat",
                status: "active",
            });
        }
        if (!codes[account.id]) codes[account.id] = account.startCode;
    }

    const nextStudents = [...students, ...addedStudents];
    const existingGroupIndex = groups.findIndex(group => group.id === LOCAL_TEST_STUDENT_GROUP.id);
    const groupStudentCount = nextStudents.filter(student => (
        student.group === LOCAL_TEST_STUDENT_GROUP.name
        && student.region === LOCAL_TEST_STUDENT_GROUP.region
    )).length;
    const nextTestGroup = { ...LOCAL_TEST_STUDENT_GROUP, count: groupStudentCount };
    const nextGroups = existingGroupIndex >= 0
        ? groups.map((group, index) => index === existingGroupIndex ? { ...group, count: groupStudentCount } : group)
        : [...groups, nextTestGroup];

    try {
        storage.setItem(ROSTER_STORAGE_KEYS.students, JSON.stringify(nextStudents));
        storage.setItem(ROSTER_STORAGE_KEYS.groups, JSON.stringify(nextGroups));
        storage.setItem(ROSTER_STORAGE_KEYS.invites, JSON.stringify(invites));
        storage.setItem(STUDENT_CODES_STORAGE_KEY, JSON.stringify(codes));
        return { seeded: true, addedStudents: addedStudents.length };
    } catch {
        return { seeded: false, addedStudents: 0 };
    }
}
