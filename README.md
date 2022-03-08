# Github Notifications Bot

Takes your githib notifications feed and generates notifications in a Matrix room.

Doesn't work terribly well because I can't find a way to get any information on
what changed in a 'thread' from the GitHub API. As a result, you just get a
notification that a pull request / issue has been updated, and then have to
search through the thread to find what's changed.

To prevent the room from going ding every time you get a notification, you can use:
```
curl -X PUT --data-binary '{"actions": ["notify"]}' -H 'Authorization: Bearer [token goes here]' 'https://matrix.org/_matrix/client/v3/pushrules/global/room/[room ID]'
```
