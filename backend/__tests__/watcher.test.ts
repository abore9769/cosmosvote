import { EventWatcher } from '../src/watcher';

// Mock the Horizon HTTP client used by watcher.ts
jest.mock('../src/horizon', () => ({
  fetchContractEvents: jest.fn(),
}));

import { fetchContractEvents } from '../src/horizon';

const mockedFetch = fetchContractEvents as jest.MockedFunction<
  typeof fetchContractEvents
>;

describe('EventWatcher', () => {
  let watcher: EventWatcher;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    watcher = new EventWatcher({
      contractId: 'CABC123',
      pollIntervalMs: 1000,
    });
  });

  afterEach(() => {
    watcher.stop();
    jest.useRealTimers();
  });

  describe('start/stop lifecycle', () => {
    it('starts polling and invokes the Horizon client', async () => {
      mockedFetch.mockResolvedValue([]);

      watcher.start();
      expect(watcher.isRunning()).toBe(true);

      await jest.advanceTimersByTimeAsync(1000);
      expect(mockedFetch).toHaveBeenCalledTimes(1);
    });

    it('does not start twice when already running', async () => {
      mockedFetch.mockResolvedValue([]);

      watcher.start();
      watcher.start();

      await jest.advanceTimersByTimeAsync(1000);
      expect(mockedFetch).toHaveBeenCalledTimes(1);
    });

    it('stops polling and clears the interval', async () => {
      mockedFetch.mockResolvedValue([]);

      watcher.start();
      await jest.advanceTimersByTimeAsync(1000);
      expect(mockedFetch).toHaveBeenCalledTimes(1);

      watcher.stop();
      expect(watcher.isRunning()).toBe(false);

      await jest.advanceTimersByTimeAsync(5000);
      expect(mockedFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('cursor persistence', () => {
    it('passes the cursor to the Horizon client on subsequent polls', async () => {
      mockedFetch
        .mockResolvedValueOnce([{ id: '1', pagingToken: 'cursor-1' }])
        .mockResolvedValueOnce([]);

      watcher.start();
      await jest.advanceTimersByTimeAsync(1000);
      await jest.advanceTimersByTimeAsync(1000);

      expect(mockedFetch).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ cursor: undefined })
      );
      expect(mockedFetch).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ cursor: 'cursor-1' })
      );
    });

    it('resumes from a persisted cursor on restart', async () => {
      mockedFetch.mockResolvedValue([]);

      watcher = new EventWatcher({
        contractId: 'CABC123',
        pollIntervalMs: 1000,
        cursor: 'persisted-cursor',
      });

      watcher.start();
      await jest.advanceTimersByTimeAsync(1000);

      expect(mockedFetch).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: 'persisted-cursor' })
      );
    });
  });

  describe('event parsing', () => {
    it('emits parsed events to registered listeners', async () => {
      const handler = jest.fn();
      watcher.onEvent(handler);

      mockedFetch.mockResolvedValue([
        { id: '1', pagingToken: 'cursor-1', topic: ['transfer'] },
      ]);

      watcher.start();
      await jest.advanceTimersByTimeAsync(1000);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ id: '1', topic: ['transfer'] })
      );
    });

    it('catches and logs parsing errors without stopping the watcher', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const handler = jest.fn();
      watcher.onEvent(handler);

      mockedFetch.mockResolvedValue([
        { id: 'bad', pagingToken: 'cursor-bad', topic: null },
      ]);

      watcher.start();
      await jest.advanceTimersByTimeAsync(1000);

      expect(errorSpy).toHaveBeenCalled();
      expect(watcher.isRunning()).toBe(true);

      errorSpy.mockRestore();
    });
  });

  describe('error handling', () => {
    it('logs Horizon client errors and keeps polling', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      mockedFetch.mockRejectedValueOnce(new Error('network failure'));
      mockedFetch.mockResolvedValueOnce([]);

      watcher.start();
      await jest.advanceTimersByTimeAsync(1000);
      expect(errorSpy).toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1000);
      expect(mockedFetch).toHaveBeenCalledTimes(2);
      expect(watcher.isRunning()).toBe(true);

      errorSpy.mockRestore();
    });
  });
});
