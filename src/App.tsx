import PWABadge from "./PWABadge.tsx";
import Terminal from "./Terminal.tsx";
import { useState, useEffect } from "react";
import Peer, { DataConnection } from "peerjs";
import "./App.css";
import {
  OFFLINE,
  ONLINE,
  LOGGED_IN,
  CONNECTING,
  CONNECTED,
  CLI_CHAT,
  CLI_CHAT_AA,
} from "./consts.ts";
import CryptoJS from "crypto-js";

const App = () => {
  const [status, setStatus] = useState<number>(OFFLINE);
  const [peerId, setPeerId] = useState<string>("");
  const [peer, setPeer] = useState<Peer | null>(null);
  const [conn, setConn] = useState<DataConnection | null>(null);
  const [pendingConnection, setPendingConnection] =
    useState<DataConnection | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [secretKey, setSecretKey] = useState<string>("");

  useEffect(() => {
    setMessages([CLI_CHAT_AA]);
    addTerminal(
      CLI_CHAT,
      "Welcome to CLI-CHAT. Type 'help' to see the list of commands."
    );
    if (navigator.onLine) {
      setStatus(ONLINE);
    }
  }, []);

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const command = e.currentTarget.value;
      addTerminal(peerId, command);
      runCommand(command);
      e.currentTarget.value = "";
    }
  };

  const runCommand = (command: string) => {
    const [action, ...args] = command.split(" ");
    if (!isAllowedAction(action)) {
      addTerminal(CLI_CHAT, "Invalid command or incorrect status.");
      return;
    }

    switch (action) {
      case "login":
        handleLoginCommand(args);
        break;
      case "connect":
        handleConnectCommand(args);
        break;
      case "disconnect":
        handleDisconnectCommand();
        break;
      case "logout":
        handleLogoutCommand();
        break;
      case "help":
        handleHelpCommand();
        break;
      case "log":
        handleLogCommand(args);
        break;
      case "loglist":
        handleLogListCommand();
        break;
      case "logdelete":
        handleLogDeleteCommand(args);
        break;
      default:
        handleDefaultCommand(action, command);
        break;
    }
  };

  const isAllowedAction = (action: string): boolean => {
    switch (action) {
      case "login":
        return status === ONLINE;
      case "connect":
        return status === LOGGED_IN;
      case "disconnect":
        return status === CONNECTED;
      case "logout":
        return status === LOGGED_IN || status === CONNECTED;
      case "help":
      case "log":
      case "loglist":
      case "logdelete":
        return true;
      default:
        return true;
    }
  };

  const handleLoginCommand = (args: string[]) => {
    const id = args[0] || "";
    initializePeer(id);
  };

  const handleConnectCommand = (args: string[]) => {
    const id = args[0];
    const key = args[1] || "";
    id
      ? connectToPeer(id, key)
      : addTerminal(CLI_CHAT, "Need a destination ID.");
  };

  const handleDisconnectCommand = () => {
    if (conn) {
      conn.close();
      setStatus(LOGGED_IN);
      addTerminal(CLI_CHAT, "Disconnected.");
    }
  };

  const handleLogoutCommand = () => {
    peer?.destroy();
    setStatus(ONLINE);
    setPeer(null);
    setPeerId("");
    addTerminal(CLI_CHAT, "Logged out.");
  };

  const handleHelpCommand = () => {
    addTerminal(
      CLI_CHAT,
      `Commands:
      - login <id>: Set your peer ID and initialize the PeerJS instance. Example: login myPeerId
      - connect <peerId> [<key>]: Connect to another peer. Optionally use encryption with a key. Example: connect peerId 123456
      - disconnect: Disconnect from the current peer.
      - logout: Log out from your current session and return to the online status.
      - help: Show this help message.
      - log <dateTime> [<key>]: Display log entries for the given date. Optionally decrypt with the provided key. Example: log 2024-12-01 123456
      - loglist: List all available log dates.
      - logdelete <dateTime> | all: Delete logs for the specified date or all logs. Example: logdelete 2024-12-01 or logdelete all`
    );
  };

  const handleLogCommand = (args: string[]) => {
    const dateTime = args[0] || "";
    const key = args[1] || "";

    if (!dateTime) {
      addTerminal(
        CLI_CHAT,
        "Usage: log <dateTime> [<key>] (e.g., log 2024-12-01 [key])"
      );
      return;
    }

    const log = getLog(dateTime);
    if (log) {
      const messages = log.split("\n").filter(Boolean);
      messages.forEach((message) => {
        const [sender, encryptedMessage] = message.split("> ");
        if (key) {
          try {
            const decryptedMessage = CryptoJS.AES.decrypt(
              encryptedMessage,
              key
            ).toString(CryptoJS.enc.Utf8);
            addTerminal(sender, decryptedMessage);
          } catch (e) {
            addTerminal(
              CLI_CHAT,
              `Failed to decrypt message: ${encryptedMessage}`
            );
          }
        } else {
          addTerminal(sender, encryptedMessage);
        }
      });
    } else {
      addTerminal(CLI_CHAT, "No logs found for the specified date.");
    }
  };

  const handleLogListCommand = () => {
    const keys = getAllLogKeys();
    keys.length > 0
      ? keys.forEach((key) => addTerminal(CLI_CHAT, key))
      : addTerminal(CLI_CHAT, "No logs found.");
  };

  const handleLogDeleteCommand = (args: string[]) => {
    const option = args[0] || "";
    if (option === "all") {
      localStorage.clear();
      addTerminal(CLI_CHAT, "All logs have been deleted.");
    } else {
      const dateTime = option;
      if (!dateTime) {
        addTerminal(
          CLI_CHAT,
          "Usage: logdelete <dateTime> (e.g., logdelete 2025-07-05) or logdelete all"
        );
        return;
      }
      if (localStorage.getItem(dateTime)) {
        localStorage.removeItem(dateTime);
        addTerminal(CLI_CHAT, `Log for ${dateTime} has been deleted.`);
      } else {
        addTerminal(CLI_CHAT, "No logs found for the specified date.");
      }
    }
  };

  const handleDefaultCommand = (action: string, command: string) => {
    if (status === CONNECTING) {
      confirmConnect(command);
    } else if (status === CONNECTED) {
      sendMessage(command);
    }
  };

  const initializePeer = (id: string) => {
    setIsProcessing(true);
    const peer = new Peer(id);
    setPeer(peer);

    peer.on("open", (id) => {
      setPeerId(id);
      setStatus(LOGGED_IN);
      addTerminal(CLI_CHAT, `Your ID has been set to ${id}`);
      setIsProcessing(false);
    });

    peer.on("connection", (connection) => {
      connection.on("open", () => {
        setStatus(CONNECTING);
        setPendingConnection(connection);
        const msg =
          connection.label === "encrypt"
            ? `${connection.peer} wants to encrypt connect. Do you accept? (y <key>/n)`
            : `${connection.peer} wants to connect. Do you accept? (y/n)`;
        addTerminal(CLI_CHAT, msg);
      });
    });

    peer.on("disconnected", () => {
      setStatus(ONLINE);
      addTerminal(CLI_CHAT, "Disconnected.");
    });

    peer.on("close", () => {
      setStatus(ONLINE);
      addTerminal(CLI_CHAT, "Peer closed.");
    });

    peer.on("error", (err) => {
      addTerminal(CLI_CHAT, err.message);
      setIsProcessing(false);
    });
  };

  const connectToPeer = (destinationPeerId: string, key: string) => {
    if (peer) {
      const connection = peer.connect(destinationPeerId);
      if (key) {
        connection.label = "encrypt";
        setSecretKey(key);
      } else {
        connection.label = "";
        setSecretKey("");
      }
      setUpConnectionEvents(connection, destinationPeerId, key);
    }
  };

  const setUpConnectionEvents = (
    connection: DataConnection,
    peerId: string,
    key: string
  ) => {
    connection.on("open", () => {
      setStatus(CONNECTED);
      setConn(connection);
      addTerminal(CLI_CHAT, `Connecting to ${peerId} ...`);
    });

    connection.on("data", (data) => {
      const message = key
        ? CryptoJS.AES.decrypt(data as string, key).toString(CryptoJS.enc.Utf8)
        : (data as string);
      addTerminal(connection.peer, message);
      saveLog(connection.peer, message);
    });

    connection.on("error", (err) => {
      setStatus(LOGGED_IN);
      addTerminal(CLI_CHAT, `Error connecting to ${peerId}: ${err.message}`);
    });

    connection.on("close", () => {
      setStatus(LOGGED_IN);
      addTerminal(CLI_CHAT, `Connection to ${peerId} closed.`);
    });
  };

  const confirmConnect = (command: string) => {
    if (!pendingConnection) return;
    const connection = pendingConnection;
    if (connection.label === "encrypt") {
      handleEncryptedConnection(command, connection);
    } else {
      handleRegularConnection(command, connection);
    }
  };

  const handleEncryptedConnection = (
    command: string,
    connection: DataConnection
  ) => {
    const [accept, key] = command.split(" ");
    if (accept === "y" && key) {
      setUpPendingConnection(connection, key);
    } else if (command === "n") {
      connection.close();
      setStatus(LOGGED_IN);
      setPendingConnection(null);
      addTerminal(CLI_CHAT, `Connection to ${connection.peer} canceled.`);
    } else {
      addTerminal(CLI_CHAT, "Invalid response. Please enter 'y <key>' or 'n'.");
    }
  };

  const handleRegularConnection = (
    command: string,
    connection: DataConnection
  ) => {
    if (command === "y") {
      setUpPendingConnection(connection);
    } else if (command === "n") {
      connection.close();
      setStatus(LOGGED_IN);
      setPendingConnection(null);
      addTerminal(CLI_CHAT, `Connection to ${connection.peer} canceled.`);
    } else {
      addTerminal(CLI_CHAT, "Invalid response. Please enter 'y' or 'n'.");
    }
  };

  const setUpPendingConnection = (connection: DataConnection, key?: string) => {
    setStatus(CONNECTED);
    setConn(connection);
    if (key) setSecretKey(key);

    connection.on("data", (data) => {
      const message = key
        ? CryptoJS.AES.decrypt(data as string, key).toString(CryptoJS.enc.Utf8)
        : (data as string);
      addTerminal(connection.peer, message);
      saveLog(connection.peer, message);
    });

    connection.on("error", (err) => {
      setStatus(LOGGED_IN);
      addTerminal(
        CLI_CHAT,
        `Error connecting to ${connection.peer}: ${err.message}`
      );
    });

    connection.on("close", () => {
      setStatus(LOGGED_IN);
      addTerminal(CLI_CHAT, `Connection to ${connection.peer} closed.`);
    });

    connection.send(`${peerId} is connected with you.`);
    addTerminal(CLI_CHAT, `Connected to ${connection.peer}.`);
    setPendingConnection(null);
  };

  const sendMessage = (message: string) => {
    if (conn && conn.open) {
      if (conn.label === "encrypt") {
        const encryptedMessage = CryptoJS.AES.encrypt(
          message,
          secretKey
        ).toString();
        conn.send(encryptedMessage);
        saveLog(peerId, encryptedMessage);
      } else {
        conn.send(message);
        saveLog(peerId, message);
      }
    }
  };

  const addTerminal = (sender: string, message: string) => {
    setMessages((prevMessages) => [...prevMessages, `${sender}> ${message}\n`]);
  };

  const saveLog = (sender: string, message: string) => {
    const timestamp = new Date();
    const dateKey = `${timestamp.getFullYear()}-${String(
      timestamp.getMonth() + 1
    ).padStart(2, "0")}-${String(timestamp.getDate()).padStart(2, "0")}`;
    const existingLog = localStorage.getItem(dateKey) || "";
    localStorage.setItem(dateKey, `${existingLog}${sender}> ${message}\n`);
  };

  const getLog = (dateKey: string): string | null => {
    return localStorage.getItem(dateKey);
  };

  const getAllLogKeys = (): string[] => {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      keys.push(localStorage.key(i) || "");
    }
    return keys;
  };

  return (
    <>
      <div className="crt">
        <Terminal
          peerId={peerId}
          messages={messages}
          isProcessing={isProcessing}
          keyDownEvent={handleInputKeyDown}
        />
      </div>
      <PWABadge />
    </>
  );
};

export default App;
