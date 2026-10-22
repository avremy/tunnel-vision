import streamDeck, { LogLevel } from "@elgato/streamdeck";
import { NativeVpnToggle } from "./actions/native-vpn";
import { VpnToggle } from "./actions/vpn-toggle";

streamDeck.logger.setLevel(LogLevel.INFO);
streamDeck.actions.registerAction(new VpnToggle());
streamDeck.actions.registerAction(new NativeVpnToggle());
streamDeck.connect();
