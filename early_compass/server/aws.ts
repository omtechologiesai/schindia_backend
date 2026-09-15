/**
 * AWS clients, created once. Credentials come from the SDK's standard chain: AWS_ACCESS_KEY_ID /
 * AWS_SECRET_ACCESS_KEY in the environment (the server's env file), AWS_PROFILE locally, or an
 * instance role.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { config } from './config';

export const dynamodb = new DynamoDBClient({
  region: config.aws.region,
  ...(config.aws.dynamodbEndpoint ? { endpoint: config.aws.dynamodbEndpoint } : {}),
});

/** Plain JS values in and out; undefined fields are dropped rather than rejected. */
export const ddb = DynamoDBDocumentClient.from(dynamodb, { marshallOptions: { removeUndefinedValues: true } });

let s3Client: S3Client | null = null;
export const s3 = (): S3Client => (s3Client ??= new S3Client({ region: config.aws.region }));

let sesClient: SESv2Client | null = null;
export const ses = (): SESv2Client => (sesClient ??= new SESv2Client({ region: config.aws.region }));
