#!/usr/bin/env python3
"""
PTY helper for Hermes Workspace terminal.
Spawns a real PTY process and bridges stdin/stdout.
Usage: python3 pty-helper.py [cwd] [cols] [rows] -- [command arg1 arg2 ...]
If no command is provided, falls back to an interactive shell.
"""
import sys, os, pty, select, signal, struct, fcntl, termios

def set_winsize(fd, rows, cols):
    s = struct.pack('HHHH', rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, s)

def main():
    default_shell = '/bin/zsh' if sys.platform == 'darwin' else '/bin/bash'

    cwd = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('HOME', '/tmp')
    cols = int(sys.argv[2]) if len(sys.argv) > 2 else 80
    rows = int(sys.argv[3]) if len(sys.argv) > 3 else 24

    command = None
    if '--' in sys.argv[4:]:
        idx = sys.argv.index('--', 4)
        tail = sys.argv[idx + 1:]
        if tail:
            command = tail

    if command is None:
        shell = os.environ.get('SHELL', default_shell)
        command = [shell, '-i']

    if cwd.startswith('~'):
        cwd = os.path.expanduser(cwd)

    # Create PTY
    master_fd, slave_fd = pty.openpty()
    set_winsize(master_fd, rows, cols)

    pid = os.fork()
    if pid == 0:
        # Child: become session leader, set controlling terminal
        os.setsid()
        os.close(master_fd)

        # Set slave as controlling terminal
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)

        os.dup2(slave_fd, 0)
        os.dup2(slave_fd, 1)
        os.dup2(slave_fd, 2)
        if slave_fd > 2:
            os.close(slave_fd)

        os.chdir(cwd)
        os.environ['TERM'] = 'xterm-256color'
        os.environ['COLORTERM'] = 'truecolor'
        os.execvp(command[0], command)
    else:
        # Parent: bridge stdin <-> master_fd <-> stdout
        os.close(slave_fd)

        # Make stdin non-blocking
        import io
        stdin_fd = sys.stdin.fileno()
        stdout_fd = sys.stdout.fileno()

        # Set stdout to binary/unbuffered
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, write_through=True)

        # Resize is delivered out-of-band on fd 3 (a dedicated control
        # pipe, separate from stdin) as a line of text "cols rows\n".
        # Previously this relied on SIGWINCH + re-reading COLUMNS/LINES
        # from os.environ, but a running child processs environment can
        # never be updated from the parent after spawn -- every resize
        # was silently re-applying the original spawn-time size forever.
        resize_fd = 3
        try:
            os.set_blocking(resize_fd, False)
            has_resize_fd = True
        except OSError:
            has_resize_fd = False

        resize_buf = b''

        def apply_resize(cols_val, rows_val):
            try:
                set_winsize(master_fd, rows_val, cols_val)
                os.kill(pid, signal.SIGWINCH)
            except Exception:
                pass

        try:
            watch_fds = [master_fd, stdin_fd] + ([resize_fd] if has_resize_fd else [])
            while True:
                rlist, _, _ = select.select(watch_fds, [], [], 1.0)
                
                if master_fd in rlist:
                    try:
                        data = os.read(master_fd, 65536)
                    except OSError:
                        break
                    if not data:
                        break
                    os.write(stdout_fd, data)

                if stdin_fd in rlist:
                    try:
                        data = os.read(stdin_fd, 65536)
                    except OSError:
                        break
                    if not data:
                        break
                    os.write(master_fd, data)

                if has_resize_fd and resize_fd in rlist:
                    try:
                        chunk = os.read(resize_fd, 4096)
                    except OSError:
                        chunk = b''
                    if chunk:
                        resize_buf += chunk
                        while b'\n' in resize_buf:
                            line, resize_buf = resize_buf.split(b'\n', 1)
                            parts = line.decode('ascii', 'ignore').split()
                            if len(parts) == 2:
                                try:
                                    apply_resize(int(parts[0]), int(parts[1]))
                                except ValueError:
                                    pass
        except (IOError, OSError):
            pass
        finally:
            os.close(master_fd)
            try:
                os.kill(pid, signal.SIGTERM)
                os.waitpid(pid, 0)
            except:
                pass

if __name__ == '__main__':
    main()
