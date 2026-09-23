/**
 * Public primitive-component barrel.
 *
 * Implementations live under ./components/ so unrelated primitives can evolve
 * independently while existing imports from "./components" remain stable.
 */
export { View, Row, Column, Portal } from "./components/layout";
export type { ViewProps, PortalProps } from "./components/layout";
export { Window } from "./components/window";
export type { WindowProps, WindowCloseRequestEvent } from "./components/window";
export { Pressable } from "./components/pressable";
export type { PressableProps } from "./components/pressable";
export { Icon } from "./components/icon";
export type { IconName, IconProps } from "./components/icon";
export { Text } from "./components/text";
export type { TextProps } from "./components/text";
export { Button } from "./components/button";
export type { ButtonProps } from "./components/button";
export { Image } from "./components/image";
export type { ImageProps } from "./components/image";
export { Scroll } from "./components/scroll";
export type { ScrollProps } from "./components/scroll";
export { Input, TextArea } from "./components/input";
export type { InputType, InputProps, TextAreaProps } from "./components/input";
export { TitleBar } from "./components/titlebar";
export type { TitleBarProps } from "./components/titlebar";
export { Modal, Dialog } from "./components/modal";
export type { ModalProps, DialogProps } from "./components/modal";
