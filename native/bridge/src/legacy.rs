// Original one-shot execution path retained for comparison and rollback.
use super::*;

pub(super) async fn execute(udid: &str, request: Request) -> Result<Value> {
    if matches!(&request, Request::Screenshot) { return Err("Screenshot byte capture requires worker mode".into()); }
    if matches!(
        request,
        Request::InstallApp { .. } | Request::UninstallApp { .. }
    ) {
        let result = async {
            let mut mux = UsbmuxdConnection::default().await?;
            let device = mux.get_device(udid).await?;
            let provider = device.to_provider(UsbmuxdAddr::from_env_var()?, "poki-mcp");
            match request {
                Request::InstallApp {
                    ipa_path,
                    bundle_id,
                    staging_id,
                } => {
                    installation::install(
                        &provider,
                        std::path::Path::new(&ipa_path),
                        &bundle_id,
                        &staging_id,
                    )
                    .await
                }
                Request::UninstallApp { bundle_id } => {
                    installation::uninstall(&provider, &bundle_id).await
                }
                _ => unreachable!(),
            }
        }
        .await;
        return Ok(result.unwrap_or_else(
            |error| json!({"isError":true,"outcome":"not_sent","error":error.to_string()}),
        ));
    }
    if let Request::LaunchApp(request) = request {
        let result = async {
            let (mut adapter, mut rsd, _provider) = connect_device(udid).await?;
            apps::launch(&mut adapter, &mut rsd, request).await
        }
        .await;
        return Ok(result.unwrap_or_else(apps::not_sent));
    }
    let (mut adapter, mut rsd, provider) = connect_device(udid).await?;
    if matches!(request, Request::ListApps) {
        return apps::list(&mut adapter, &mut rsd, &provider).await;
    }
    if let Request::Configuration { method, value } = request {
        return configuration::execute(&mut adapter, &mut rsd, &method, value).await;
    }
    if let Request::AxTree { include_offscreen } = request {
        return ax::read_tree(&mut adapter, &rsd, include_offscreen).await;
    }
    if matches!(request, Request::DisplayInfo) {
        let mut display =
            idevice::core_device::DisplayServiceClient::connect_rsd(&mut adapter, &mut rsd).await?;
        let info = display.get_media_support_info().await?;
        return Ok(serde_json::to_value(info)?);
    }
    let mut media = stream::start_screen_media_stream(&mut adapter, &mut rsd, 1)
        .await
        .map_err(|e| format!("Cannot establish input media session: {e}"))?;
    trace("media ready");
    tokio::time::sleep(Duration::from_millis(1000)).await;
    // The device sometimes drops a touch whose connection closes straight after its last report, with no
    // error. The touch connection therefore stays open through the wait that follows the action;
    // NATIVE.md has the counts.
    let mut touch: Option<Touch> = None;
    let action: Result<Value> = async {
        match request {
            Request::DisplayInfo
            | Request::Screenshot
            | Request::ListApps
            | Request::InstallApp { .. }
            | Request::UninstallApp { .. }
            | Request::AxTree { .. }
            | Request::Configuration { .. }
            | Request::LaunchApp(_) => {
                unreachable!()
            }
            Request::Tap { x, y, duration_ms } | Request::LongPress { x, y, duration_ms } => {
                let hid = touch.insert(Touch::connect_rsd(&mut adapter, &mut rsd).await?);
                held_tap(hid, x, y, duration_ms).await?;
            }
            Request::DoubleTap { x, y, duration_ms } => {
                let hid = touch.insert(Touch::connect_rsd(&mut adapter, &mut rsd).await?);
                held_tap(hid, x, y, duration_ms).await?;
                tokio::time::sleep(Duration::from_millis(80)).await;
                held_tap(hid, x, y, duration_ms).await?;
            }
            Request::Drag {
                x1,
                y1,
                x2,
                y2,
                duration_ms,
                hold_ms,
                end_hold_ms,
            } => {
                let hid = touch.insert(Touch::connect_rsd(&mut adapter, &mut rsd).await?);
                Drag {
                    x1,
                    y1,
                    x2,
                    y2,
                    duration_ms,
                    hold_ms,
                    end_hold_ms,
                }
                .send(hid)
                .await?;
            }
            Request::Pinch {
                x,
                y,
                start_distance,
                end_distance,
                angle,
                duration_ms,
            } => {
                let hid = touch.insert(Touch::connect_rsd(&mut adapter, &mut rsd).await?);
                Pinch {
                    x,
                    y,
                    start_distance,
                    end_distance,
                    angle,
                    duration_ms,
                }
                .send(hid)
                .await?;
            }
            Request::Key {
                key,
                modifiers,
                count,
            } => {
                let mut keyboard = Keyboard::connect(&mut adapter, &mut rsd).await?;
                let usages = modifiers
                    .iter()
                    .map(|m| modifier_usage(m))
                    .collect::<Result<Vec<_>>>()?;
                let outcome: Result<()> = async {
                    for _ in 0..count {
                        chord(&mut keyboard, key_usage(&key)?, &usages).await?;
                    }
                    Ok(())
                }
                .await;
                let cleanup = keyboard.close().await;
                outcome?;
                cleanup?;
            }
            Request::Button {
                button,
                count,
                interval_ms,
            } => {
                let mut keyboard = Indigo::connect_rsd(&mut adapter, &mut rsd).await?;
                let (code, duration) = button_usage(&button)?;
                for index in 0..count {
                    if index > 0 {
                        tokio::time::sleep(Duration::from_millis(interval_ms)).await;
                    }
                    keyboard.send_button(0x0c, code, ButtonState::Down).await?;
                    tokio::time::sleep(Duration::from_millis(duration)).await;
                    keyboard.send_button(0x0c, code, ButtonState::Up).await?;
                }
            }
            Request::TypeText {
                text,
                clear,
                submit,
                target,
            } => {
                let mut keyboard = Keyboard::connect(&mut adapter, &mut rsd).await?;
                let outcome = pasteboard::paste_text(
                    &mut adapter,
                    &rsd,
                    &mut keyboard,
                    &text,
                    clear,
                    submit,
                    target.as_ref(),
                )
                .await;
                let cleanup = keyboard.close().await;
                let result = outcome?;
                cleanup?;
                return Ok(result);
            }
        }
        Ok(json!({"sent":true,"screen_change_verified":false}))
    }
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    drop(touch);
    let stop = media.client.stop_media_stream().await;
    drop(media.audio_udp);
    drop(media.video_udp);
    let output = action?;
    stop?;
    Ok(output)
}
