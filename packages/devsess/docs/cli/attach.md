# Attach to a service

Read this when you need to send keyboard input to a running service and return safely to your shell.

`devsess attach [options] [preset|run-id]` connects an interactive terminal to one service and prints the keyboard shortcuts after obtaining its input lease. Press `Ctrl-]` once to detach; press it twice to send a literal `Ctrl-]` to the service. `Ctrl-C` is sent to the service. A trailing `Ctrl-]` waits up to 250 ms for a second byte: another `Ctrl-]` is forwarded, while another byte is forwarded before detaching. If the timeout expires, attach detaches and later terminal input is no longer sent to the service. This is a text transport, not an arbitrary-byte channel.

Only one client can hold the input lease at a time; disconnecting releases it. To choose the run and service explicitly, see `devsess docs read selecting`. For completion statuses, see `devsess docs read troubleshooting`.
