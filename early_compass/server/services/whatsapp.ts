/**
 * WhatsApp delivery in one of two modes:
 *
 *  - cloud_api: with WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN set, the PDF is uploaded
 *    to the WhatsApp Business Cloud API and sent as a document. Messages to parents are
 *    business-initiated, so production use needs an approved template (WHATSAPP_TEMPLATE_NAME)
 *    with a DOCUMENT header and three body variables: parent name, child's first name, date.
 *    Without a template a plain document message is sent, which WhatsApp only delivers inside
 *    a 24-hour customer-service window.
 *
 *  - click_to_chat: no credentials needed. The portal opens wa.me with the message and a
 *    secure report link prefilled, and staff press send in their own WhatsApp.
 */
import { DISCLAIMER_NOT_DIAGNOSTIC, ORG_NAME, orgAndCentre, PRODUCT_NAME } from '@shared/copy';
import { formatDate } from '@shared/format';
import { normalisePhone } from '@shared/phone';
import { config } from '../config';

export const whatsappMode: 'cloud_api' | 'click_to_chat' = config.whatsapp ? 'cloud_api' : 'click_to_chat';

export interface WhatsAppMessageInput {
  parentName: string;
  childFirstName: string;
  centre: string;
  assessedAt: string;
  shareUrl: string;
  shareExpiresAt: string;
  senderName: string;
}

export function buildWhatsAppMessage(input: WhatsAppMessageInput): string {
  const tz = config.timeZone;
  return [
    `Hello ${input.parentName},`,
    '',
    `${input.childFirstName}’s ${PRODUCT_NAME} report from ${orgAndCentre(input.centre)} is ready. It covers the assessment on ${formatDate(input.assessedAt, tz, 'long')}.`,
    '',
    `View or download the PDF: ${input.shareUrl}`,
    `(link valid until ${formatDate(input.shareExpiresAt, tz, 'long')})`,
    '',
    `${DISCLAIMER_NOT_DIAGNOSTIC.title}: this is a reference tool, not a clinical assessment. Please talk with your paediatrician about any developmental concerns.`,
    '',
    `— ${input.senderName}, ${ORG_NAME}`,
  ].join('\n');
}

export function clickToChatUrl(phoneE164: string, message: string): string {
  const phone = normalisePhone(phoneE164);
  if (!phone) throw new Error('Invalid phone number for WhatsApp');
  return `https://wa.me/${phone.digits}?text=${encodeURIComponent(message)}`;
}

interface GraphError {
  error?: { message?: string; code?: number; error_data?: { details?: string } };
}

async function graph<T>(pathname: string, init: RequestInit): Promise<T> {
  const wa = config.whatsapp!;
  const response = await fetch(`https://graph.facebook.com/${wa.apiVersion}/${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${wa.accessToken}`, ...(init.headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json().catch(() => ({}))) as T & GraphError;
  if (!response.ok) {
    const detail = body.error?.error_data?.details ?? body.error?.message;
    throw new Error(detail ? `WhatsApp API: ${detail}` : `WhatsApp API responded with HTTP ${response.status}`);
  }
  return body;
}

export async function sendReportViaCloudApi(input: {
  to: string;
  pdf: Buffer;
  fileName: string;
  caption: string;
  parentName: string;
  childFirstName: string;
  assessedAtText: string;
}): Promise<{ messageId: string }> {
  const wa = config.whatsapp;
  if (!wa) throw new Error('WhatsApp Cloud API is not configured');
  const phone = normalisePhone(input.to);
  if (!phone) throw new Error('Invalid phone number for WhatsApp');

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'application/pdf');
  form.append('file', new Blob([new Uint8Array(input.pdf)], { type: 'application/pdf' }), input.fileName);
  const media = await graph<{ id: string }>(`${wa.phoneNumberId}/media`, { method: 'POST', body: form });

  const payload = wa.templateName
    ? {
        messaging_product: 'whatsapp',
        to: phone.digits,
        type: 'template',
        template: {
          name: wa.templateName,
          language: { code: wa.templateLanguage },
          components: [
            { type: 'header', parameters: [{ type: 'document', document: { id: media.id, filename: input.fileName } }] },
            {
              type: 'body',
              parameters: [
                { type: 'text', text: input.parentName },
                { type: 'text', text: input.childFirstName },
                { type: 'text', text: input.assessedAtText },
              ],
            },
          ],
        },
      }
    : {
        messaging_product: 'whatsapp',
        to: phone.digits,
        type: 'document',
        document: { id: media.id, filename: input.fileName, caption: input.caption.slice(0, 1024) },
      };

  const sent = await graph<{ messages?: { id: string }[] }>(`${wa.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { messageId: sent.messages?.[0]?.id ?? '' };
}
