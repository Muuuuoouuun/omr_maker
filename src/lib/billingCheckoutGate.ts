export const LIVE_CHECKOUT_IMPLEMENTED = false;

export function isLiveCheckoutUiEnabled(providerReady: boolean): boolean {
    return LIVE_CHECKOUT_IMPLEMENTED && providerReady;
}
