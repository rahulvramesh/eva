import type { RoutingPolicy } from "../../../packages/protocol/src/index";

const DEVICE_INTENT = /\b(file|folder|directory|repo|repository|workspace|shell|bash|terminal|command|installed|computer|mac|windows|local|project)\b/i;

export function shouldRouteToDevice(
  routing: RoutingPolicy,
  content: string,
  deviceAvailable: boolean,
  preferredDeviceModel: boolean,
): boolean {
  if (!deviceAvailable) return false;
  return routing === "device"
    || routing === "private"
    || preferredDeviceModel
    || (routing === "auto" && DEVICE_INTENT.test(content));
}

export function isPrivateCapableModel(model: { localInference?: boolean } | undefined): boolean {
  return model?.localInference === true;
}
