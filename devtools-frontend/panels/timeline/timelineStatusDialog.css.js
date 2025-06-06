// Copyright 2025 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.
// IMPORTANT: this file is auto generated. Please do not edit this file.
/* istanbul ignore file */
export default {
  cssContent: `/*
 * Copyright (c) 2015 The Chromium Authors. All rights reserved.
 * Use of this source code is governed by a BSD-style license that can be
 * found in the LICENSE file.
 */

.timeline-status-dialog {
  display: flex;
  flex-direction: column;
  padding: 16px 16px 12px;
  align-self: center;
  background-color: var(--sys-color-cdt-base-container);
  box-shadow: var(--drop-shadow);
  border-radius: 10px;
}

.status-dialog-line {
  margin: 2px;
  height: 14px;
  min-height: auto;
  display: flex;
  align-items: baseline;
  font-variant-numeric: tabular-nums;
}

.status-dialog-line .label {
  display: inline-block;
  width: 80px;
  text-align: right;
  color: var(--sys-color-on-surface);
  margin-right: 10px;
}

.timeline-status-dialog .progress .indicator-container {
  display: inline-block;
  width: 200px;
  height: 8px;
  background-color: var(--sys-color-surface5);
}

.timeline-status-dialog .progress .indicator {
  background-color: var(--sys-color-primary);
  height: 100%;
  width: 0;
  margin: 0;
}

.timeline-status-dialog .stop-button {
  margin-top: 8px;
  height: 100%;
  align-self: flex-end;
}

.timeline-status-dialog .stop-button button {
  border-radius: 12px;
}

@media (forced-colors: active) {
  .timeline-status-dialog {
    border: 1px solid canvastext;
  }

  .timeline-status-dialog .progress .indicator-container {
    border: 1px solid ButtonText;
    background-color: ButtonFace;
  }

  .timeline-status-dialog .progress .indicator {
    forced-color-adjust: none;
    background-color: ButtonText;
  }
}

:host {
  container-type: inline-size;
}

/* 326 is the widths above (200 + 80) + a bunch of padding. calc() can't be used here sadly */
@container (max-width: 326px) {
  .timeline-status-dialog {
    box-shadow: none;

    .stop-button {
      align-self: center;
    }
  }

  .status-dialog-line {
    flex-direction: column;

    .label {
      display: none;
    }
  }
}

/*# sourceURL=${import.meta.resolve('./timelineStatusDialog.css')} */
`
};