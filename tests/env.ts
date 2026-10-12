import { generateVapidKeys } from "../src/shared/web-push";

const keys = generateVapidKeys();
process.env.VAPID_PUBLIC_KEY = keys.publicKey;
process.env.VAPID_PRIVATE_KEY = keys.privateKey;
process.env.VAPID_SUBJECT = "mailto:tests@magicstudio.test";
// Online payments on, against a fake Stripe (tests/stripe-fake.ts); shops without a connected account
// still pay by manual transfer.
process.env.STRIPE_SECRET_KEY = "sk_test_fake";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
// Fixed hold times: a developer's local .env may shorten them for manual tests.
process.env.PAYMENT_HOLD_CARD_MIN = "20";
process.env.PAYMENT_HOLD_TRANSFER_MIN = "60";
