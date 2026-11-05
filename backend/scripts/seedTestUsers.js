require("dotenv").config();

if (process.env.SEED_TEST_USERS !== "true") {
	console.error("Set SEED_TEST_USERS=true to confirm writing test accounts to Firestore.");
	process.exit(1);
}

const admin = require("firebase-admin");
const db = require("../config/firebase");

const COLLECTION_NAME = "2025";
const TEST_USERS = [
	{
		username: "TEST006",
		name: "Test Student",
		email: "test.student@example.com",
		password: "12345678",
		role: "student",
	},
	{
		username: "ADMIN",
		name: "Test Administrator",
		email: "test.admin@example.com",
		password: "12345678",
		role: "admin",
	},
];

async function seedTestUsers() {
	const now = admin.firestore.Timestamp.now();
	const batch = db.batch();
	for (const user of TEST_USERS) {
		const { username, ...userData } = user;
		batch.set(db.collection(COLLECTION_NAME).doc(username), {
			...userData,
			createdAt: now,
			lastUpdated: now,
		}, { merge: true });
	}
	await batch.commit();
	console.log(`Seeded ${TEST_USERS.length} test accounts in Firestore collection "${COLLECTION_NAME}":`);
	for (const { username, email, role } of TEST_USERS) {
		console.log(`- ${role}: ${username} or ${email}`);
	}
}

seedTestUsers()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error("Failed to seed test accounts:", error.message);
		process.exit(1);
	});
