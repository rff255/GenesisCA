QT       += core gui widgets opengl

TARGET = modeler
TEMPLATE = app
CONFIG += console

INCLUDEPATH += $$PWD/modeler/ \
               $$PWD/../../third-party/
               $$PWD/../../third-party/imgui
               $$PWD/../../third-party/imgui/glfw

HEADERS  += \
    ca_modeler_gui.h \
    ModelPropertiesHandler/model_properties_handler_widget.h \
    ModelPropertiesHandler/model_attr_init_value.h \
    AttributeHandler/attribute_handler_widget.h \
    VicinityHandler/vicinity_handler_widget.h \
    UpdateRulesHandler/update_rules_handler.h \
    UpdateRulesHandler/update_rules_editor.h \
    UpdateRulesHandler/node_graph_instance.h \
    ColorMappingsHandler/color_mappings_handler_widget.h \
    model/ca_model.h \
    model/model_properties.h \
    model/attribute.h \
    model/neighborhood.h \
    model/mapping.h \
    $$PWD/../../third-party/imgui/imgui.h \
    $$PWD/../../third-party/imgui/imgui_impl_glfw.h \
    $$PWD/../../third-party/imgui/imconfig.h \
    $$PWD/../../third-party/imgui/imgui_internal.h \
    $$PWD/../../third-party/imgui/glfw/glfw3native.h \
    $$PWD/../../third-party/imgui/stb_textedit.h \
    $$PWD/../../third-party/imgui/stb_rect_pack.h \
    $$PWD/../../third-party/imgui/stb_truetype.h \
    $$PWD/../../third-party/imgui/imguinodegrapheditor.h

SOURCES += \
  main.cpp \
  ca_modeler_gui.cpp \
  ModelPropertiesHandler/model_properties_handler_widget.cpp \
  ModelPropertiesHandler/model_attr_init_value.cpp \
  AttributeHandler/attribute_handler_widget.cpp \
  VicinityHandler/vicinity_handler_widget.cpp \
  UpdateRulesHandler/update_rules_handler.cpp \
  UpdateRulesHandler/update_rules_editor.cpp \
  ColorMappingsHandler/color_mappings_handler_widget.cpp \
  model/ca_model.cpp \
  $$PWD/../../third-party/imgui/imgui.cpp \
  $$PWD/../../third-party/imgui/imgui_impl_glfw.cpp \
  $$PWD/../../third-party/imgui/imgui_draw.cpp \
  $$PWD/../../third-party/imgui/imguinodegrapheditor.cpp

FORMS    += \
    ca_modeler_gui.ui \
    ModelPropertiesHandler/model_properties_handler_widget.ui \
    ModelPropertiesHandler/model_attr_init_value.ui \
    AttributeHandler/attribute_handler_widget.ui \
    VicinityHandler/vicinity_handler_widget.ui \
    UpdateRulesHandler/update_rules_handler.ui \
    ColorMappingsHandler/color_mappings_handler_widget.ui

LIBS += -lOpenGL32
LIBS += "-L$$PWD/../../third-party/imgui/glfw" -lglfw3dll
DEPENDPATH += "$$PWD/../../third-party/imgui/glfw"

# Copies the standalone folder so that the compilation of CA models has the required files
CONFIG += file_copies
COPIES += standalone_files
# The following commands copies some unnecessary files but that's negligible.
standalone_files.files = $$files($$PWD/../../third-party/imgui/*.h) # imgui .h
standalone_files.files += $$files($$PWD/../../third-party/imgui/*.cpp) # imgui .cpp
standalone_files.files += $$files($$PWD/../../third-party/imgui/glfw/*) # glfw
standalone_files.files += $$files($$PWD/../simulator/main.cpp) # simulator main
standalone_files.files += $$files($$PWD/../simulator/bitmap_image.hpp) # bitmap exporter
CONFIG(debug, debug|release) {
  standalone_files.path = $$OUT_PWD/debug/StandaloneApplication
} else {
  standalone_files.path = $$OUT_PWD/release/StandaloneApplication
}
