// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ToastHost, { showToast, toast } from './Toast';

let height = 80;
beforeEach(() => {
    vi.useFakeTimers();
    height = 80;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        return { height: this.classList.contains('toast-host') ? height : 0 } as DOMRect;
    });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('toast space beside distribution dialogs', () => {
    it('updates reserved space when the visible notice grows and releases it on unmount', () => {
        let notify!: () => void;
        const disconnect = vi.fn();
        vi.stubGlobal('ResizeObserver', class {
            constructor(callback: () => void) { notify = callback; }
            observe() { /* browser observation replaced by explicit resize below */ }
            disconnect = disconnect;
        });
        const view = render(<ToastHost />);
        act(() => showToast('info', '확인 안내'));
        expect(document.documentElement.style.getPropertyValue('--active-toast-height')).toBe('80px');
        height = 160;
        act(() => notify());
        expect(document.documentElement.style.getPropertyValue('--active-toast-height')).toBe('160px');
        view.unmount();
        expect(disconnect).toHaveBeenCalledOnce();
        expect(document.documentElement.style.getPropertyValue('--active-toast-height')).toBe('');
    });

    it('measures on viewport resize without ResizeObserver and releases space after expiry', () => {
        vi.stubGlobal('ResizeObserver', undefined);
        render(<ToastHost />);
        act(() => showToast('success', '저장 완료', undefined, 100));
        height = 110;
        fireEvent(window, new Event('resize'));
        expect(document.documentElement.style.getPropertyValue('--active-toast-height')).toBe('110px');
        act(() => vi.advanceTimersByTime(100));
        expect(screen.queryByRole('region', { name: '알림' })).toBeNull();
        expect(document.documentElement.style.getPropertyValue('--active-toast-height')).toBe('');
    });

    it('preserves queued action notices while the first notice owns the reserved space', () => {
        vi.stubGlobal('ResizeObserver', undefined);
        const undo = vi.fn();
        render(<ToastHost />);
        act(() => {
            showToast('info', '먼저 표시되는 안내', undefined, 100);
            toast.action('success', '삭제됨', undefined, { actionLabel: '실행 취소', onAction: undo });
        });
        expect(screen.queryByRole('button', { name: '실행 취소' })).toBeNull();
        act(() => vi.advanceTimersByTime(100));
        fireEvent.click(screen.getByRole('button', { name: '실행 취소' }));
        expect(undo).toHaveBeenCalledOnce();
        expect(screen.queryByRole('region', { name: '알림' })).toBeNull();
        expect(document.documentElement.style.getPropertyValue('--active-toast-height')).toBe('');
    });
});
