// Partner Application, Job Application, and Contact form submissions — Partners/Careers/Contact
// rebuild. Field validation (mirrors the client-side checks in the frontend's forms — this is
// the server-side copy that actually gets enforced) and the two Klaviyo confirmation-email
// triggers named in the design doc §9: "message-received" (Contact) and "submission-received"
// (Partner + Job applications, shared template with conditional content).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/.+\..+/i;

export const PARTNERSHIP_TYPES = ['content_creator', 'journalist', 'nonprofit', 'smb'] as const;
export type PartnershipType = (typeof PARTNERSHIP_TYPES)[number];

export const CONTACT_TOPICS = ['general', 'press', 'partnerships', 'support', 'other'] as const;
export type ContactTopic = (typeof CONTACT_TOPICS)[number];

/** Field-level validation failure — matches the `{ errors: { field: message } }` 400 shape the frontend reads. */
export type FieldErrors = Record<string, string>;

const clean = (v: unknown, max = 5000): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export interface PartnerApplicationInput {
  fullName: string;
  email: string;
  partnershipType: PartnershipType;
  orgOrChannelName: string;
  link: string;
  aboutWork: string;
  source: string | null;
}

export function validatePartnerApplication(
  body: Record<string, unknown>
): { data: PartnerApplicationInput } | { errors: FieldErrors } {
  const fullName = clean(body.fullName, 200);
  const email = clean(body.email, 200).toLowerCase();
  const partnershipType = clean(body.partnershipType, 50) as PartnershipType;
  const orgOrChannelName = clean(body.orgOrChannelName, 200);
  const link = clean(body.link, 500);
  const aboutWork = clean(body.aboutWork, 5000);
  const source = clean(body.source, 200) || null;

  const errors: FieldErrors = {};
  if (!fullName) errors.fullName = 'Full name is required.';
  if (!email) errors.email = 'Email is required.';
  else if (!EMAIL_RE.test(email)) errors.email = 'Enter a valid email address.';
  if (!PARTNERSHIP_TYPES.includes(partnershipType)) errors.partnershipType = 'Choose a valid partnership type.';
  if (!orgOrChannelName) errors.orgOrChannelName = 'This field is required.';
  if (!link) errors.link = 'Link is required.';
  else if (!URL_RE.test(link)) errors.link = 'Enter a valid URL (https://...).';
  if (!aboutWork) errors.aboutWork = 'Tell us about your work.';

  if (Object.keys(errors).length > 0) return { errors };
  return { data: { fullName, email, partnershipType, orgOrChannelName, link, aboutWork, source } };
}

export interface JobApplicationInput {
  fullName: string;
  email: string;
  linkedinUrl: string | null;
  whyUnravel: string;
  roleId: string | null;
  resumeBase64: string | null;
  resumeFileName: string | null;
  resumeMimeType: string | null;
}

const RESUME_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
export const RESUME_MAX_BYTES = 10 * 1024 * 1024; // 10MB

export function validateJobApplication(
  body: Record<string, unknown>
): { data: JobApplicationInput } | { errors: FieldErrors } {
  const fullName = clean(body.fullName, 200);
  const email = clean(body.email, 200).toLowerCase();
  const linkedinUrl = clean(body.linkedinUrl, 500) || null;
  const whyUnravel = clean(body.whyUnravel, 5000);
  const roleId = clean(body.roleId, 100) || null;
  const resumeBase64 = typeof body.resumeBase64 === 'string' && body.resumeBase64.trim() ? body.resumeBase64.trim() : null;
  const resumeFileName = clean(body.resumeFileName, 255) || null;
  const resumeMimeType = clean(body.resumeMimeType, 100) || null;

  const errors: FieldErrors = {};
  if (!fullName) errors.fullName = 'Full name is required.';
  if (!email) errors.email = 'Email is required.';
  else if (!EMAIL_RE.test(email)) errors.email = 'Enter a valid email address.';
  if (linkedinUrl && !URL_RE.test(linkedinUrl)) errors.linkedinUrl = 'Enter a valid URL (https://...).';
  if (!whyUnravel) errors.whyUnravel = 'Tell us why you want to join.';
  if (resumeBase64) {
    if (!resumeMimeType || !RESUME_MIME_TYPES.has(resumeMimeType)) {
      errors.resume = 'Resume must be a PDF, DOC, or DOCX file.';
    } else {
      // base64 is ~4/3 the size of the decoded bytes — cheap upper-bound check before decoding.
      const approxBytes = Math.ceil((resumeBase64.length * 3) / 4);
      if (approxBytes > RESUME_MAX_BYTES) errors.resume = 'Resume must be under 10MB.';
    }
  }

  if (Object.keys(errors).length > 0) return { errors };
  return { data: { fullName, email, linkedinUrl, whyUnravel, roleId, resumeBase64, resumeFileName, resumeMimeType } };
}

export interface ContactMessageInput {
  fullName: string;
  email: string;
  topic: ContactTopic;
  message: string;
}

export function validateContactMessage(
  body: Record<string, unknown>
): { data: ContactMessageInput } | { errors: FieldErrors } {
  const fullName = clean(body.fullName, 200);
  const email = clean(body.email, 200).toLowerCase();
  const topicRaw = clean(body.topic, 50) as ContactTopic;
  const topic = CONTACT_TOPICS.includes(topicRaw) ? topicRaw : 'general';
  const message = clean(body.message, 10000);

  const errors: FieldErrors = {};
  if (!fullName) errors.fullName = 'Full name is required.';
  if (!email) errors.email = 'Email is required.';
  else if (!EMAIL_RE.test(email)) errors.email = 'Enter a valid email address.';
  if (!message) errors.message = 'Message is required.';

  if (Object.keys(errors).length > 0) return { errors };
  return { data: { fullName, email, topic, message } };
}

/** Klaviyo metric name for Email 1 — "We got your message" (design doc §9.1). */
export const CONTACT_MESSAGE_METRIC_NAME = 'Contact Message Received';
/** Klaviyo metric name for Email 2 — shared "We got your submission" template (design doc §9.2). */
export const SUBMISSION_RECEIVED_METRIC_NAME = 'Submission Received';

async function postKlaviyoEvent(metricName: string, email: string, fullName: string, properties: Record<string, unknown>): Promise<void> {
  const apiKey = process.env.KLAVIYO_API_KEY?.trim();
  if (!apiKey) {
    console.warn(`[klaviyo] KLAVIYO_API_KEY not set — skipping "${metricName}" event`);
    return;
  }
  const [firstName, ...rest] = fullName.trim().split(/\s+/);
  const lastName = rest.join(' ');
  const revision = process.env.KLAVIYO_REVISION?.trim() || '2024-10-15';

  const response = await fetch('https://a.klaviyo.com/api/events/', {
    method: 'POST',
    headers: {
      Authorization: `Klaviyo-API-Key ${apiKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      revision,
    },
    body: JSON.stringify({
      data: {
        type: 'event',
        attributes: {
          properties,
          metric: { data: { type: 'metric', attributes: { name: metricName } } },
          profile: {
            data: {
              type: 'profile',
              attributes: {
                email,
                ...(firstName ? { first_name: firstName } : {}),
                ...(lastName ? { last_name: lastName } : {}),
              },
            },
          },
        },
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Klaviyo "${metricName}" event failed (${response.status}): ${text.slice(0, 300)}`);
  }
}

/**
 * Fires the Contact Confirmation event ("We got your message"). Never throws for a missing
 * key — confirmation email delivery must not block the contact form response (spec §6: on
 * success the user gets a confirmation UI regardless of whether the email itself sends).
 */
export async function sendContactConfirmationEvent(input: { email: string; fullName: string; topic: string; message: string }): Promise<void> {
  await postKlaviyoEvent(CONTACT_MESSAGE_METRIC_NAME, input.email, input.fullName, {
    name: input.fullName,
    topic: input.topic,
    message_preview: input.message.slice(0, 300),
  });
}

/**
 * Fires the shared Submission Confirmation event ("We got your submission") for both the
 * Partner Application and Job Application forms — one Klaviyo template with conditional
 * content blocks keyed on `submission_type`, per design doc §9.2 (not three separate emails).
 */
export async function sendSubmissionConfirmationEvent(
  input:
    | { email: string; fullName: string; submissionType: 'partner'; partnershipType: string; orgOrChannelName: string }
    | { email: string; fullName: string; submissionType: 'job'; roleId: string | null }
): Promise<void> {
  const properties: Record<string, unknown> =
    input.submissionType === 'partner'
      ? {
          submission_type: 'partner',
          partnership_type: input.partnershipType,
          org_or_channel_name: input.orgOrChannelName,
          name: input.fullName,
        }
      : {
          submission_type: 'job',
          role_id: input.roleId,
          is_general_application: !input.roleId,
          name: input.fullName,
        };
  await postKlaviyoEvent(SUBMISSION_RECEIVED_METRIC_NAME, input.email, input.fullName, properties);
}
