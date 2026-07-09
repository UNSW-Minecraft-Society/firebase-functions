/* Cloud function to send an email to a new member to welcome them, provide
 * introductory information and most importantly, provide a verification key so
 * they can join the society Discord server.
 *
 * This function requires the following Firebase env values to be set:
 * BREVO_API_KEY                API key to access Sendgrid's email service
 * BREVO_FROM_EMAIL             The sender email to attach to emails
 * BREVO_FROM_NAME              The sender name to attach to emails
 * SETTINGS_DEFAULT_COLLECTION  The collection to use by default
 * AUTH_KEY                     The key that the addUser HTTPS request must pass to its API header
 * For more information, see here https://firebase.google.com/docs/functions/config-env
 */

import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { setGlobalOptions } from "firebase-functions/v2";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onRequest, onCall } from "firebase-functions/v2/https";
import { defineString, defineSecret } from "firebase-functions/params";

import { TransactionalEmailsApi, SendSmtpEmail } from "@getbrevo/brevo";

import uuid from 'uuid';
const { v4: uuidv4 } = uuid;

// Closest region to Sydney supporting cloud functions
const default_region = 'asia-northeast1'; // Tokyo
setGlobalOptions({region: default_region});

// environmental parameters
const default_collection = defineString("SETTINGS_DEFAULT_COLLECTION");
const auth_key = defineString("AUTH_KEY");
const brevo_api_key_secret = defineSecret("BREVO_API_KEY");

initializeApp();

// the firestore database reference
const db = getFirestore();


// Function to get the Brevo Email API instance
function getEmailApiInstance(api_key) {
    const apiInstance = new TransactionalEmailsApi();
    apiInstance.authentications.apiKey.apiKey = api_key;
    return apiInstance;
}

/* Send email with welcome and verification information to the user
 * @param user_id   user's Firebase doc id
 * @param data      user's Firebase doc data
 */
async function sendEmailToNewMember(email_api, user_id, data) {
    // Try UNSW email first
    let to_email = null;
    let unsw_email = 'N/A';
    if (data.unsw_id) {
        to_email = `${data.unsw_id}@ad.unsw.edu.au`;
        unsw_email = to_email;
    } else {
        to_email = data.email;
    }
    const minecraft_username = data.minecraft_username || '<none given>';
    const discord_username = data.discord_username || '<none given>';
    console.log(data);
    console.log(to_email);
    // console.log(`${process.env.BREVO_FROM_NAME}`);

    let message = new SendSmtpEmail();
    message.sender = { name: `${process.env.BREVO_FROM_NAME}`, email: `${process.env.BREVO_FROM_EMAIL}` };
    message.to = [{email: `${to_email}`, name: `${data.first_name} ${data.last_name}`}];
    // message.templateId = `${process.env.BREVO_TEMPLATE_ID}`;
    message.subject = "UNSW MCSoc Verification"
    message.htmlContent = `<!DOCTYPE html><html>
        <body>
        <h1>Verify Your Email</h1>
        <p>Hey there {{params.minecraft_username}},<br>
        <br>
        Thanks for your interest in joining our society! To verify your account, please DM the following to the bot:<br>
        <code>!verify {{params.user_id}} {{params.verification_code}}</code> .<br>
        <br>
        Sincerely,<br>
        UNSW Minecraft Society Team.</p>`
    message.params = {
        "name": `${data.first_name} ${data.last_name}`,
        "email": `${to_email}`,
        "unsw_email": `${unsw_email}`,
        "minecraft_username": `${minecraft_username}`,
        "discord_username": `${discord_username}`,
        "user_id": `${user_id}`,
        "verification_code": `${data.verification_code}`
    },


    email_api.sendTransacEmail(message)
    .then((res) => {
        console.log(JSON.stringify(res.body));
        return res;
    })
    .catch((err) => {
        console.error(`Error sending email: ${err.code}, ${err.response.statusText}: ${err.response.data.message}`)
    });
}


/* Add verification code to new member and fire off an email.
 * This function is triggered whenever there's a new entry
 * in the Firestore collection.
 *
 * The following must be provided in the doc data:
 * @param first_name            Passed to verification email
 * @param last_name             Passed to verification email
 * @param minecraft_username    Passed to verification email
 * @param email OR unsw_id   So that we have an email to send to
 */
export const onNewMember = onDocumentCreated({
    document: "members-test/{userID}",
    secrets: [brevo_api_key_secret]
},
    async (e) => {
        const doc = e.data;
        if (!doc) {
            console.log("No data associated with the event");
            return;
        }

        const data = doc.data();
        const id = doc.id;
        console.log(`Got document ${id}`);

        // Add verification status and code to the document
        const verification_code = uuidv4();
        data.is_verified = false;
        data.verification_code = verification_code;

        data.normalised_minecraft_username = (data.minecraft_username ? data.minecraft_username.trim().toLowerCase() : null);
        if (data.discord_username) data.discord_username = data.discord_username.trim().toLowerCase();

        await db.collection(default_collection.value()).doc(id).set(data);

        // Then fire off an email!
        const api_instance = getEmailApiInstance(brevo_api_key_secret.value());
        await sendEmailToNewMember(api_instance, id, data);
        return;
    }
);


// HTTPS API endpoint to add a new member.
// Content-Type should be application/json
// Header should have this parameter:
//     "Authorization": <string>
//     "Content-Type": application/json
// JSON should be like this:
// {
//     "timestamp": <string>,
//     "first_name": <string>,
//     "last_name": <string>,
//     "email": <string>,
//     "discord_username": <string>,
//     "minecraft_username": <string>,
//     "unsw_id": <string>
// }
//
// Returns HTTP response (200 OK, or some error code)
//
export const addUser = onRequest(async (req, res) => {
        if (req.method !== 'PUT') {
            return res.status(405).send('Incorrect method');
        }
        if (!req.header('Authorization')
            || req.header('Authorization') !== auth_key.value()) {
            console.error("key: " + auth_key.value());
            console.error('Unauthorized key sent: ', req.header('Authorization'));
            return res.status(401).send('Unauthorized');
        }

        console.log('Received add user request. Request body: ', req.body);
        const timestamp = req.body.timestamp;
        const first_name = req.body.first_name;
        const last_name = req.body.last_name;
        const email = req.body.email;
        const discord_username = req.body.discord_username || null;
        const minecraft_username = req.body.minecraft_username || null;
        const unsw_id = req.body.unsw_id || null;

        try {
            if (!discord_username && !minecraft_username) {
                throw new Error("Both fields 'discord_username' and 'minecraft_username' are empty!");
            }

            const addDoc = await db.collection(default_collection.value()).add(
                {
                    timestamp: timestamp,
                    first_name: first_name,
                    last_name: last_name,
                    email: email,
                    discord_username: discord_username,
                    minecraft_username: minecraft_username,
                    unsw_id: unsw_id,
                }
            );
            console.log('Added new doc with ID: ', addDoc.id);
            return res.status(200).send('OK');
        } catch (err) {
            console.error(err);
            return res.status(500).send('Internal server error');
        }

        /* WARNING: Remember to ensure that this function will always return a response!
         * To test, uncomment the line below and run the linter. If linter says the line
         * below is unreachable, you may re-comment it and continue to deploy
         */
        // return res.status(500).send('Internal server error');
    }
);


// HTTPS API endpoint to verify user.
// Content-Type should be application/json
// JSON should be like this:
// {
//     "user_id": <string>,
//     "verification_code": <string>,
//     "discord_id": <string>
// }
//
// Returns JSON like this:
// {
//     "is_verified": <boolean>
// }
export const verifyUser = onRequest(
    async (req, res) => {
        if (req.method !== 'POST') {
            return res.status(405).send('Incorrect method');
        }

        console.log('Received verification request. Request body: ', req.body);
        const user_id = req.body.user_id;
        const verification_code = req.body.verification_code;
        const discord_id = req.body.discord_id;

        if (!user_id || !verification_code || !discord_id) {
            return res.status(400).send('Invalid data provided');
        }
        const userRef = db.collection(default_collection.value()).doc(user_id);

        try {
            const userDoc = await userRef.get();
            if (!userDoc.exists) {
                return res.status(401).send('User does not exist');
            }

            const userData = userDoc.data();

            // If user is already verified, skip this and return their verification status
            if (!userData.is_verified) {
                if (verification_code === userData.verification_code) {
                    userData.is_verified = true;
                    userData.discord_id = discord_id;
                    db.collection(default_collection.value()).doc(user_id).set(userData);
                }
            }
            res.setHeader('Content-Type', 'application/json');
            return res.json({"is_verified": userData.is_verified});
        } catch (err) {
            console.log('Error getting document', err);
            return res.status(500).send('Internal server error');
        }

        /* WARNING: Remember to ensure that this function will always return a response!
         * To test, uncomment the line below and run the linter. If linter says the line
         * below is unreachable, you may re-comment it and continue to deploy
         */
        // return res.status(500).send('Internal server error');
    }
);


// HTTPS API endpoint to search for a member by Discord ID or Minecraft Username
// Content-Type should be application/json
// Header should have this parameter:
//     "Authorization": <string>
//     "Content-Type": application/json
// JSON should be like this:
// {
//     "discord_id": <string> <optional>,
//     "minecraft_username": <string> <optional>
// }
//
// Returns HTTP response (200 OK, or some error code)
//
export const findUser = onRequest(
    async (req, res) => {
        if (req.method !== 'POST') {
            return res.status(405).send('Incorrect method');
        }
        if (!req.header('Authorization')
            || req.header('Authorization') !== auth_key.value()) {
            console.error('Unauthorized key sent: ', req.header('Authorization'));
            return res.status(401).send('Unauthorized');
        }

        console.log('Received search user request. Request body: ', req.body);
        const discord_username = req.body.discord_id || null;
        const minecraft_username = req.body.minecraft_username || null;
        try {
            let query = db.collection(default_collection.value());
            if (minecraft_username) {
                query = query.where('normalised_minecraft_username', '==', minecraft_username.trim().toLowerCase());
            } else if (discord_username) {
                query = query.where('discord_username', '==', discord_username.trim().toLowerCase());
            }
            const result = await query.get();

            const payload = [];
            if (!result.empty) {
                result.forEach(doc => {
                    let data = doc.data();
                    data["firestore_id"] = doc.id;
                    payload.push(data);
                });
            }
            return res.json({ "results": payload });
        } catch (err) {
            console.error(err);
            return res.status(500).send('Internal server error');
        }

        /* WARNING: Remember to ensure that this function will always return a response!
         * To test, uncomment the line below and run the linter. If linter says the line
         * below is unreachable, you may re-comment it and continue to deploy
         */
        // return res.status(500).send('Internal server error');
    }
);


// HTTPS API endpoint to normalise member entries by Discord ID or Minecraft Username
// Content-Type should be application/json
// Header should have this parameter:
//     "Authorization": <string>
//     "Content-Type": application/json
// JSON should be like this:
// {
//     "discord_id": <string> <optional>,
//     "minecraft_username": <string> <optional>
// }
//
// Returns HTTP response (200 OK, or some error code)
//
export const normaliseEntry = onRequest(
    async (req, res) => {
        if (req.method !== 'POST') {
            return res.status(405).send('Incorrect method');
        }
        if (!req.header('Authorization')
            || req.header('Authorization') !== auth_key.value()) {
            console.error('Unauthorized key sent: ', req.header('Authorization'));
            return res.status(401).send('Unauthorized');
        }

        console.log('Received search user request. Request body: ', req.body);
        const discord_username = req.body.discord_id || null;
        const minecraft_username = req.body.minecraft_username || null;
        try {
            let query = db.collection(default_collection.value());
            if (minecraft_username) {
                query = query.where('normalised_minecraft_username', '==', minecraft_username.trim().toLowerCase());
            } else if (discord_username) {
                query = query.where('discord_username', '==', discord_username.trim().toLowerCase());
            }
            const result = await query.get();

            const payload = [];
            if (!result.empty) {
                await db.runTransaction(async transaction => {
                    result.forEach(doc => {
                        const data = doc.data();
                        payload.push(data);
                        if (data.is_verified == false) {
                           transaction.delete(doc.ref);
                        } else {
                            const norm_mc_username = data.minecraft_username ? data.minecraft_username.trim().toLowerCase() : null;
                            const disc_username = data.discord_username ? data.discord_username.trim().toLowerCase() : null;
                            transaction.update(doc.ref, {
                                normalised_minecraft_username: norm_mc_username,
                                discord_username: disc_username
                            });
                        }
                    });
                });
            }
            return res.json({ "results": payload });
        } catch (err) {
            console.error(err);
            return res.status(500).send('Internal server error');
        }
    }
);


// probably will take forver (a long time)!
export const normaliseEntries = onCall(
    async (req, res) => {
        if (req.method !== 'POST') {
            return res.status(405).send('Incorrect method');
        }
        if (!req.header('Authorization')
            || req.header('Authorization') !== auth_key.value()) {
            console.error('Unauthorized key sent: ', req.header('Authorization'));
            return res.status(401).send('Unauthorized');
        }

        const dataset = await db.collection(default_collection.value()).get();
        const docs_all = dataset.docs;

        const docs_per_transaction = 500;
        for (let i = 0; i < docs_all.length; i += docs_per_transaction) {
            console.log(i);
            const docs_slice = docs_all.slice(i, i + docs_per_transaction);
            await db.runTransaction(async transaction => {
                const transaction_docs = await Promise.all(docs_slice.map(doc => transaction.get(doc.ref)));

                transaction_docs.forEach(doc => {
                    const data = doc.data();
                    if (data.is_verified == false) {
                       transaction.delete(doc.ref);
                    } else {
                        const norm_mc_username = data.minecraft_username ? data.minecraft_username.trim().toLowerCase() : null;
                        const disc_username = data.discord_username ? data.discord_username.trim().toLowerCase() : null;
                        transaction.update(doc.ref, {
                            normalised_minecraft_username: norm_mc_username,
                            discord_username: disc_username
                        });
                    }
                });
            });
        }
    }
);
