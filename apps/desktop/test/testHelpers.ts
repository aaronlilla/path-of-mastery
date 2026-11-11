import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { layerSigningPayload, type UpdateLayer, type UpdateLayerName } from '@pom/protocol';

export function generateTestKeypair(): { publicKey: KeyObject; privateKey: KeyObject } {
  return generateKeyPairSync('ed25519');
}

export function signLayer(
  layerName: UpdateLayerName,
  fields: Omit<UpdateLayer, 'signature'>,
  privateKey: KeyObject,
): UpdateLayer {
  const payload = Buffer.from(layerSigningPayload(layerName, fields), 'utf8');
  const signature = cryptoSign(null, payload, privateKey).toString('base64');
  return { ...fields, signature };
}
